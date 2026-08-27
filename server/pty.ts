import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import * as nodePty from 'node-pty';
import { LOG_DIR } from './paths.js';
import { resolveShellEnv, fallbackPathEntries } from './shell-env.js';

/** Keep this much replayable history per terminal, and trim above the cap. */
const LOG_CAP_BYTES = 8 * 1024 * 1024;
const LOG_KEEP_BYTES = 4 * 1024 * 1024;

export interface TermInfo {
  id: string;
  sessionId: string | null;
  cwd: string;
  pid: number;
  cols: number;
  rows: number;
  startedAt: number;
  exited: boolean;
  exitCode: number | null;
  /** When the process exited, for reaping. null while it is running. */
  exitedAt: number | null;
}

interface Term {
  info: TermInfo;
  proc: nodePty.IPty;
  logPath: string;
  logFd: number | null;
  logBytes: number;
}

const terms = new Map<string, Term>();
export const ptyEvents = new EventEmitter();

/**
 * Terminal ids reach the filesystem via the scrollback log path, so they must
 * never contain path syntax. `path.join(LOG_DIR, '../../x' + '.log')` escapes
 * LOG_DIR entirely, which turned the unauthenticated attach socket into an
 * arbitrary *.log read and the start endpoint into an arbitrary *.log truncate.
 * Session ids are UUIDs and generated ids are 'new-<base36>-<base36>', so a
 * conservative charset costs nothing.
 */
const TERM_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidTermId(id: unknown): id is string {
  return typeof id === 'string' && TERM_ID_RE.test(id);
}

/**
 * Strip Claude Code's own session-scoped environment before spawning.
 *
 * This server is itself usually launched from inside a Claude Code session, so
 * process.env carries that session's markers. Passing them through is actively
 * harmful, and mostly silent:
 *
 *   CLAUDE_CODE_CHILD_SESSION   turns transcript saving OFF, so sessions
 *                               started here write no JSONL at all — deleting
 *                               the very data this tool reads
 *   CLAUDE_CODE_SESSION_ID      makes the child believe it is the parent
 *   CLAUDE_CODE_MESSAGING_*     lets the child message into the parent's
 *                               channel: a real isolation leak
 *   CLAUDE_EFFORT               silently inherits the parent's effort level
 *
 * Stripping is safe because we spawn through a login shell (`-l`), so anything
 * the user genuinely exports from their own shell config is re-applied.
 */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};

  // Start from the user's real login-shell environment when we can get it.
  // Launched from Finder or the Dock we inherit launchd's, where PATH is just
  // /usr/bin:/bin:/usr/sbin:/sbin — so `claude` is not found and the terminal
  // exits 127 before it starts.
  const shellEnv = resolveShellEnv();
  const source = shellEnv ?? (process.env as Record<string, string>);

  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (k === 'CLAUDECODE') continue;
    if (k.startsWith('CLAUDE_')) continue;
    env[k] = v;
  }

  // Keep anything the parent had that the login shell did not report, so a
  // deliberately-set variable is not silently dropped.
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k in env) continue;
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_')) continue;
    if (k === 'PATH') continue;   // the shell's PATH wins; never merge them
    env[k] = v;
  }

  env.PATH = ensurePath(env.PATH ?? process.env.PATH ?? '');
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  // Marks sessions started from here, and makes them obvious in `ps`.
  env.CLAUDE_TERMINAL = '1';
  return env;
}

/**
 * Belt and braces: if the shell probe failed we may still be on launchd's
 * minimal PATH, so append the handful of places a per-user CLI normally lives.
 * Appended, never prepended — the user's own ordering must win.
 */
function ensurePath(current: string): string {
  const parts = current.split(':').filter(Boolean);
  const seen = new Set(parts);
  for (const dir of fallbackPathEntries()) {
    if (!seen.has(dir) && fs.existsSync(dir)) {
      parts.push(dir);
      seen.add(dir);
    }
  }
  return parts.join(':');
}

function shell(): string {
  return process.env.SHELL || '/bin/zsh';
}

/**
 * `exec` matters: it replaces the login shell with claude so the PTY's pid IS
 * claude's pid. That lets us match this terminal against Claude Code's own
 * ~/.claude/sessions/<pid>.json registry and learn the session id of a
 * freshly-started session.
 */
function commandFor(sessionId: string | null, extraArgs: string[] = []): string {
  const args = sessionId ? ['--resume', sessionId, ...extraArgs] : [...extraArgs];
  const quoted = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  return `exec claude ${quoted}`.trim();
}

export function getTerm(id: string): TermInfo | null {
  return terms.get(id)?.info ?? null;
}

export function listTerms(): TermInfo[] {
  return [...terms.values()].map((t) => t.info);
}

/**
 * Decide whether an open request reuses a terminal or needs a new one, and
 * under which key.
 *
 * Reuse is the common case and must stay: asking to open a session that is
 * already open hands back the running terminal rather than spawning a second
 * PTY against the same transcript.
 *
 * The exception is a terminal whose session has moved on. `/branch` leaves the
 * terminal created as A running B, so the key A no longer describes what is in
 * it. Reusing on the key alone found that terminal under A and handed it
 * straight back — reporting success, starting nothing, and leaving A
 * unopenable until the app was restarted.
 *
 * Re-keying the existing terminal instead would be worse: its id is in the
 * live WebSocket URL and its scrollback log path, both of which would break
 * underneath a connected client. So the NEW terminal takes a fresh key, and
 * the id stays what it always was — an opaque handle the client reads back
 * from the server rather than assuming.
 */
function resolveKey(
  requested: string,
  sessionId: string | null,
): { reuse: TermInfo } | { id: string } {
  const existing = terms.get(requested);
  if (!existing) return { id: requested };
  if (existing.info.exited) {
    disposeTerm(requested);
    return { id: requested };
  }
  const serving = existing.info.sessionId;
  // Unknown on either side means we cannot say they differ; reuse, which is
  // right for a terminal still coming up and is the long-standing behaviour.
  if (!serving || !sessionId || serving === sessionId) return { reuse: existing.info };

  for (let n = 2; n < 50; n++) {
    const candidate = `${requested}-r${n}`;
    if (!terms.has(candidate) && isValidTermId(candidate)) return { id: candidate };
  }
  // Fall back to the shape a fresh session uses, so the charset still holds.
  return { id: `new-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` };
}

export function startTerm(opts: {
  id: string;
  sessionId: string | null;
  cwd: string;
  cols?: number;
  rows?: number;
  extraArgs?: string[];
}): TermInfo {
  const resolved = resolveKey(opts.id, opts.sessionId);
  // Already open for this session: hand back the running terminal. Dropping
  // this in an earlier pass would have spawned a second PTY against the same
  // transcript and orphaned the first, with no map entry left to kill it by.
  if ('reuse' in resolved) return resolved.reuse;
  const id = resolved.id;

  const cols = opts.cols ?? 120;
  const rows = opts.rows ?? 32;
  const cwd = fs.existsSync(opts.cwd) ? opts.cwd : os.homedir();

  const proc = nodePty.spawn(shell(), ['-l', '-c', commandFor(opts.sessionId, opts.extraArgs)], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: cleanEnv(),
  });

  // Guarded: an throw here escapes before terms.set() below, orphaning the
  // process we just spawned with no map entry and no way to kill it via the API.
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (err) {
    console.error('[claude-terminal] could not create log dir:', err);
  }
  const logPath = path.join(LOG_DIR, `${id}.log`);
  // A fresh terminal starts a fresh scrollback.
  let logFd: number | null = null;
  try {
    logFd = fs.openSync(logPath, 'w');
  } catch {
    logFd = null;
  }

  const term: Term = {
    info: {
      id,
      sessionId: opts.sessionId,
      cwd,
      pid: proc.pid,
      cols,
      rows,
      startedAt: Date.now(),
      exited: false,
      exitCode: null,
      exitedAt: null,
    },
    proc,
    logPath,
    logFd,
    logBytes: 0,
  };
  terms.set(id, term);

  // A disposed-and-restarted terminal reuses the same id, so these closures
  // must confirm they still own the entry. Without this, the SIGHUP'd old
  // process writes into — and then CLOSES — the new terminal's log fd, which
  // POSIX will happily have recycled to the same number.
  const isCurrent = () => terms.get(id) === term;

  proc.onData((chunk) => {
    if (!isCurrent()) return;
    appendLog(term, chunk);
    ptyEvents.emit('data', id, chunk);
  });

  proc.onExit(({ exitCode }) => {
    term.info.exited = true;
    term.info.exitCode = exitCode;
    term.info.exitedAt = Date.now();
    closeLog(term);
    if (!isCurrent()) return;
    ptyEvents.emit('exit', id, exitCode);
  });

  ptyEvents.emit('started', id, term.info);
  return term.info;
}

/** Idempotent: always clears logFd so it can never be closed twice. */
function closeLog(term: Term) {
  if (term.logFd === null) return;
  try { fs.closeSync(term.logFd); } catch { /* already gone */ }
  term.logFd = null;
}

function appendLog(term: Term, chunk: string) {
  if (term.logFd === null) return;
  try {
    const buf = Buffer.from(chunk, 'utf8');
    fs.writeSync(term.logFd, buf);
    term.logBytes += buf.length;
    if (term.logBytes > LOG_CAP_BYTES) trimLog(term);
  } catch {
    // losing scrollback is survivable; losing the session is not
  }
}

/**
 * Truncating from the front would cut mid escape-sequence, so we keep the tail
 * from the first newline inside the retained window.
 */
function trimLog(term: Term) {
  closeLog(term);
  try {
    const all = fs.readFileSync(term.logPath);
    let keep = all.subarray(Math.max(0, all.length - LOG_KEEP_BYTES));
    const nl = keep.indexOf(0x0a);
    if (nl >= 0 && nl < keep.length - 1) keep = keep.subarray(nl + 1);
    fs.writeFileSync(term.logPath, keep);
    term.logBytes = keep.length;
  } catch (err) {
    // Trimming failed (ENOSPC is the likely one). Keep recording rather than
    // silently dropping scrollback for the rest of the session; the cap will
    // just be exceeded until the next attempt succeeds.
    console.error(`[claude-terminal] log trim failed for ${term.info.id}:`, err);
  }
  try {
    term.logFd = fs.openSync(term.logPath, 'a');
  } catch {
    term.logFd = null;
    console.error(`[claude-terminal] scrollback recording stopped for ${term.info.id}`);
  }
}

/** Replayed into xterm.js on attach so scrollback survives a page reload. */
export function readScrollback(id: string): string {
  const term = terms.get(id);
  const p = term?.logPath ?? path.join(LOG_DIR, `${id}.log`);
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

export function writeTerm(id: string, data: string): boolean {
  const term = terms.get(id);
  if (!term || term.info.exited) return false;
  term.proc.write(data);
  return true;
}

export function resizeTerm(id: string, cols: number, rows: number): void {
  const term = terms.get(id);
  if (!term || term.info.exited) return;
  if (cols < 2 || rows < 2) return;
  if (term.info.cols === cols && term.info.rows === rows) return;
  try {
    term.proc.resize(cols, rows);
    term.info.cols = cols;
    term.info.rows = rows;
  } catch {
    // a resize race against an exiting process is harmless
  }
}

export function killTerm(id: string, signal = 'SIGHUP'): void {
  const term = terms.get(id);
  if (!term || term.info.exited) return;
  try { term.proc.kill(signal); } catch { /* already dead */ }
}

export function disposeTerm(id: string, opts: { unlink?: boolean } = {}): void {
  const term = terms.get(id);
  if (!term) return;
  const wasRunning = !term.info.exited;
  // Tell attached clients before we lose the ability to: once the entry is out
  // of the map, the process's own onExit sees isCurrent() false and stays
  // silent, so a second viewer would keep rendering a live-looking dead pane.
  if (wasRunning) ptyEvents.emit('exit', id, term.info.exitCode ?? 0);
  // Remove BEFORE closing the fd so the process's onData/onExit see they no
  // longer own this id and stop touching it.
  terms.delete(id);
  try { if (wasRunning) term.proc.kill('SIGHUP'); } catch { /* noop */ }
  closeLog(term);
  // Drop the scrollback only when the user is deliberately closing: an id can
  // be reused (Restart), and replaying the previous run's output into a fresh
  // terminal is worse than showing none.
  if (opts.unlink !== false) {
    try { fs.unlinkSync(term.logPath); } catch { /* already gone */ }
  }
}

/** Drop exited terminals so a long-lived daemon does not accumulate them. */
export function reapExited(maxAgeMs = 10 * 60_000): void {
  const now = Date.now();
  for (const [id, term] of terms) {
    if (!term.info.exited) continue;
    // Age from when it EXITED, not when it started. Ageing from startedAt
    // reaped every session older than the grace period on the first tick after
    // it exited — about two seconds — deleting the scrollback holding whatever
    // error had just killed it.
    if (now - (term.info.exitedAt ?? term.info.startedAt) < maxAgeMs) continue;
    terms.delete(id);
    closeLog(term);
    // This is the COMMON exit path (the user types exit, or claude quits), and
    // it runs every 2s — without the unlink, every such run orphans a log of
    // up to LOG_CAP_BYTES for the life of the daemon.
    try { fs.unlinkSync(term.logPath); } catch { /* already gone */ }
  }
}

/** pid -> termId, so session ids can be resolved from Claude's registry. */
export function livePids(): Map<number, string> {
  const out = new Map<number, string>();
  for (const [id, t] of terms) if (!t.info.exited) out.set(t.info.pid, id);
  return out;
}

/**
 * Point this terminal at the session it is CURRENTLY serving.
 *
 * Not write-once. `/branch` forks a session into a new id inside the same
 * process, so the PTY that started out running session X is now running Y —
 * and refusing the update left the branched session with no terminal at all,
 * showing "Running in another terminal" about the terminal you were sitting
 * in. Claude Code keeps one registry file per pid, so the pid always resolves
 * to exactly one current session and this cannot oscillate.
 */
export function setTermSessionId(id: string, sessionId: string): void {
  const t = terms.get(id);
  if (t) t.info.sessionId = sessionId;
}

export function shutdownAll(): void {
  // Keep the scrollback: readScrollback deliberately falls back to the on-disk
  // path for ids not in the map, so logs are what let a terminal's history
  // survive a daemon restart. Deleting them here defeated that.
  for (const id of [...terms.keys()]) disposeTerm(id, { unlink: false });
}
