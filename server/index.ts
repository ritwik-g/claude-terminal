import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';

import { initSessions, getSessions } from './sessions.js';
import { saveCache } from './scan.js';
import { loadStore, setUserState, flushStore, isSafeKey, hasUserState, isReadOnly } from './store.js';
import { readLiveSessions } from './live.js';
import {
  startTerm, writeTerm, resizeTerm, killTerm, disposeTerm,
  readScrollback, listTerms, getTerm, ptyEvents, shutdownAll,
  isValidTermId, reapExited, livePids, setTermSessionId,
} from './pty.js';
import type { Priority, UserState } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 7777);
const HOST = process.env.HOST ?? '127.0.0.1';

initSessions();
loadStore();

const app = express();
app.use(express.json({ limit: '1mb' }));

/**
 * This server binds loopback and has no auth, but "loopback" is not a security
 * boundary against a *browser*: any page the user visits can POST to it, and
 * WebSockets are exempt from CORS entirely — so a hostile page could open
 * /ws/term and type into a live claude shell. Requiring a same-origin Origin
 * and a loopback Host closes that, and closes DNS rebinding with it.
 */
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function hostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const raw = hostHeader.toLowerCase();
  // A bracketed IPv6 literal keeps its brackets; only strip a trailing :port
  // when it is not part of a bare IPv6 address ('::1' must survive intact).
  const host = raw.startsWith('[') || (raw.match(/:/g) ?? []).length > 1
    ? raw.replace(/^(\[[^\]]+\]):\d+$/, '$1')
    : raw.replace(/:\d+$/, '');
  return ALLOWED_HOSTS.has(host);
}

function originAllowed(origin: string | undefined): boolean {
  // Same-origin fetches from our own page send no Origin on GET, and send our
  // own origin otherwise. Non-browser clients (curl) send none — allowed.
  if (!origin) return true;
  try {
    return ALLOWED_HOSTS.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

app.use((req, res, next) => {
  if (!hostAllowed(req.headers.host) || !originAllowed(req.headers.origin)) {
    res.status(403).json({ error: 'forbidden origin' });
    return;
  }
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, pid: process.pid, uptime: process.uptime(), storeReadOnly: isReadOnly() });
});

app.get('/api/sessions', async (req, res) => {
  try {
    const payload = await getSessions(req.query.force === '1');
    res.json(payload);
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

const PRIORITIES: (Priority | null)[] = ['p0', 'p1', 'p2', null];
const MAX_TAGS = 20;
const MAX_TAG_LEN = 40;
const MAX_NOTE_LEN = 2000;

/** Thrown for anything the client got wrong; caught into a 400 with a reason. */
class BadRequest extends Error {}

function parseTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new BadRequest('tags must be an array');
  if (raw.length > MAX_TAGS) throw new BadRequest(`at most ${MAX_TAGS} tags`);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    // Coercing here silently turned null/123/{} into the tags "null"/"123"/
    // "[object object]"; rejecting is the honest answer.
    if (typeof item !== 'string') throw new BadRequest('every tag must be a string');
    const t = item.trim().toLowerCase();
    if (!t) continue;
    if (t.length > MAX_TAG_LEN) throw new BadRequest(`tag longer than ${MAX_TAG_LEN} chars: ${t.slice(0, 20)}…`);
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function parseBool(v: unknown, field: string): boolean {
  // `!!v` made the string "false" true, which is the opposite of what any
  // client sending JSON would expect.
  if (typeof v !== 'boolean') throw new BadRequest(`${field} must be a boolean`);
  return v;
}

function buildPatch(body: any): Partial<UserState> {
  const patch: Partial<UserState> = {};
  if ('tags' in body) patch.tags = parseTags(body.tags);
  if ('priority' in body) {
    if (!PRIORITIES.includes(body.priority)) throw new BadRequest('priority must be p0, p1, p2 or null');
    patch.priority = body.priority;
  }
  if ('pinned' in body) patch.pinned = parseBool(body.pinned, 'pinned');
  if ('archived' in body) patch.archived = parseBool(body.archived, 'archived');
  if ('note' in body) {
    if (typeof body.note !== 'string') throw new BadRequest('note must be a string');
    if (body.note.length > MAX_NOTE_LEN) throw new BadRequest(`note longer than ${MAX_NOTE_LEN} chars`);
    patch.note = body.note;
  }
  if ('snoozedUntil' in body) {
    const v = body.snoozedUntil;
    if (v === null) patch.snoozedUntil = null;
    else if (typeof v === 'number' && Number.isFinite(v) && v > 0) patch.snoozedUntil = v;
    // 0 and negatives previously persisted a row that snoozed nothing and
    // could never be cleared, because isEmpty only tested `=== null`.
    else throw new BadRequest('snoozedUntil must be a positive timestamp or null');
  }
  return patch;
}

app.patch('/api/sessions/:id/state', async (req, res) => {
  const { id } = req.params;
  if (!isValidTermId(id) || !isSafeKey(id)) {
    return res.status(400).json({ error: 'invalid session id' });
  }

  // Express 4 does NOT catch a rejected promise from an async handler: the
  // request would hang open forever with no response and no error. This is the
  // only route that awaits, so it is the only one that can reject.
  // Reporting 200 for a write we know cannot be persisted is a lie the user
  // would only discover after losing the edit.
  if (isReadOnly()) {
    return res.status(503).json({
      error:
        'state file is unreadable, so tags and priorities cannot be saved. ' +
        'Fix or remove ~/.claude-terminal/state.json and restart.',
    });
  }

  try {
    // Refuse to write state for a session that does not exist. Without this,
    // a typo'd id created a row that no view could ever reach — while its tags
    // still showed up in the global tag list with nothing owning them.
    const { sessions } = await getSessions();
    const patch = buildPatch(req.body ?? {});
    if (!sessions.some((s) => s.id === id)) {
      // Refuse to CREATE state for a session that does not exist — that is how
      // unreachable junk rows got made. But always allow state we already hold
      // to be cleared, so a row whose transcript has since been deleted still
      // has a way out.
      if (!hasUserState(id)) {
        return res.status(404).json({ error: `no such session: ${id}` });
      }
    }
    const next = setUserState(id, patch);
    return res.json({ id, user: next });
  } catch (err) {
    if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
    console.error('[claude-terminal] PATCH state failed:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

/** Negative or absurd geometry reached node-pty verbatim via `Number(x) || d`. */
function clampDim(v: unknown, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 2) return fallback;
  return Math.min(Math.floor(n), 1000);
}

app.get('/api/terms', (_req, res) => res.json({ terms: listTerms() }));

app.post('/api/terms', async (req, res) => {
  const { id, sessionId, cwd, cols, rows } = req.body ?? {};
  if (!isValidTermId(id)) {
    return res.status(400).json({ error: 'id must match [A-Za-z0-9_-]{1,128}' });
  }
  if (!cwd || typeof cwd !== 'string') return res.status(400).json({ error: 'cwd is required' });
  if (!path.isAbsolute(cwd)) return res.status(400).json({ error: 'cwd must be absolute' });
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    return res.status(400).json({ error: `cwd does not exist: ${cwd}` });
  }
  if (!stat.isDirectory()) return res.status(400).json({ error: `cwd is not a directory: ${cwd}` });

  try {
    const info = startTerm({
      id,
      sessionId: typeof sessionId === 'string' ? sessionId : null,
      cwd,
      cols: clampDim(cols, 120),
      rows: clampDim(rows, 32),
    });
    res.json({ term: info });
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

app.delete('/api/terms/:id', (req, res) => {
  if (!isValidTermId(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  const hard = req.query.hard === '1';
  if (hard) disposeTerm(req.params.id);
  else killTerm(req.params.id);
  res.json({ ok: true });
});

/**
 * A session started fresh has no id until Claude Code registers itself. Because
 * the PTY execs claude directly, our pty pid IS claude's pid, so we can watch
 * the registry for it.
 *
 * This runs on a timer rather than as a one-shot poll after spawn: registration
 * happens only after the user clears any trust prompt, which is unbounded.
 * Measured on a first run in a new directory it took 24s — past the old 20s
 * window, so the session never got adopted into the list.
 */
function resolveNewSessionIds(): void {
  const pids = livePids();
  if (pids.size === 0) return;
  let matched = false;
  for (const [sessionId, info] of readLiveSessions()) {
    const termId = pids.get(info.pid);
    if (!termId) continue;
    const term = getTerm(termId);
    if (!term || term.sessionId) continue;
    setTermSessionId(termId, sessionId);
    ptyEvents.emit('identified', termId, sessionId);
    matched = true;
  }
  if (matched) {
    void getSessions(true).catch((err) =>
      console.error('[claude-terminal] refresh after session adoption failed:', err));
  }
}

const houseKeeping = setInterval(() => {
  resolveNewSessionIds();
  reapExited();
}, 2000);
houseKeeping.unref();

// In production the built SPA is served from here; in dev Vite proxies to us.
const dist = path.join(__dirname, '..', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// Express's default handler returns an HTML stack trace with absolute paths.
// This is a JSON API; malformed input should get a JSON error.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err?.status ?? err?.statusCode ?? 500;
  const message =
    status === 413 ? 'request body too large'
    : status === 400 ? 'malformed JSON body'
    : 'internal error';
  if (status >= 500) console.error('[claude-terminal]', err);
  res.status(status).json({ error: message });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  // The http server detaches its own handlers when it emits 'upgrade', so an
  // ECONNRESET mid-handshake would emit 'error' on a bare EventEmitter.
  socket.on('error', () => { /* client vanished during the handshake */ });
  // An empty or malformed Host header makes `new URL` throw, and this runs
  // synchronously in an event handler — an uncaught throw here would take the
  // whole daemon down and orphan every PTY.
  let url: URL;
  try {
    if (!hostAllowed(req.headers.host) || !originAllowed(req.headers.origin)) {
      socket.destroy();
      return;
    }
    url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  } catch {
    socket.destroy();
    return;
  }
  if (url.pathname !== '/ws/term') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, url));
});

wss.on('connection', (ws: WebSocket, _req: http.IncomingMessage, url: URL) => {
  // ws emits 'error' on the socket for any protocol violation (bad opcode,
  // invalid UTF-8, oversized frame). An unhandled 'error' on an EventEmitter
  // throws, which would kill the daemon and orphan every terminal. Register
  // this BEFORE any early return, or the reject path is left unguarded.
  ws.on('error', (err) => console.error('[claude-terminal] ws error:', err?.message ?? err));

  const termId = url.searchParams.get('id');
  if (!isValidTermId(termId)) {
    ws.close(1008, 'invalid id');
    return;
  }

  const send = (msg: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  // Replay the disk log so a reload or reconnect keeps its scrollback.
  const history = readScrollback(termId);
  send({ type: 'attach', term: getTerm(termId), history });

  const onData = (id: string, chunk: string) => { if (id === termId) send({ type: 'data', data: chunk }); };
  const onExit = (id: string, code: number) => { if (id === termId) send({ type: 'exit', code }); };
  const onIdent = (id: string, sessionId: string) => { if (id === termId) send({ type: 'identified', sessionId }); };

  ptyEvents.on('data', onData);
  ptyEvents.on('exit', onExit);
  ptyEvents.on('identified', onIdent);

  ws.on('message', (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg?.type === 'input' && typeof msg.data === 'string') writeTerm(termId, msg.data);
    else if (msg?.type === 'resize') resizeTerm(termId, Number(msg.cols), Number(msg.rows));
  });

  // Without a keepalive, a slept laptop or dropped wifi leaves the socket open
  // indefinitely; the client reconnects and adds three more ptyEvents listeners
  // each time.
  let alive = true;
  ws.on('pong', () => { alive = true; });
  const ping = setInterval(() => {
    if (!alive) { ws.terminate(); return; }
    alive = false;
    try { ws.ping(); } catch { /* closing */ }
  }, 30_000);

  ws.on('close', () => {
    clearInterval(ping);
    ptyEvents.off('data', onData);
    ptyEvents.off('exit', onExit);
    ptyEvents.off('identified', onIdent);
  });
});

// A terminal can outlive many browser connections, so cap listeners generously
// rather than leaking the default-10 warning on every reconnect.
ptyEvents.setMaxListeners(200);

wss.on('error', (err) => console.error('[claude-terminal] wss error:', err?.message ?? err));

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[claude-terminal] port ${PORT} is already in use — is it already running?`);
    process.exit(1);
  }
  console.error('[claude-terminal] server error:', err);
});

// A crash here would orphan every PTY, so log and keep serving rather than die.
process.on('uncaughtException', (err) => console.error('[claude-terminal] uncaught:', err));
process.on('unhandledRejection', (err) => console.error('[claude-terminal] unhandled rejection:', err));

server.listen(PORT, HOST, () => {
  console.log(`claude-terminal server  http://${HOST}:${PORT}`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  flushStore();
  saveCache({ force: true });
  shutdownAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Closing the terminal that launched us must not lose debounced tag edits.
process.on('SIGHUP', shutdown);
