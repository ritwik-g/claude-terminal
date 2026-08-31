/**
 * End-to-end check that your working set survives a quit:  npm run test:restore
 *
 * This one cannot be tested against your real sessions — verifying it means
 * opening terminals, quitting, and reopening, and every one of those steps
 * would run `claude --resume` against a real transcript. So it builds a
 * throwaway HOME with synthetic transcripts and a stub `claude` on the PATH,
 * and drives two server lifetimes through it. Nothing here touches
 * ~/.claude or ~/.claude-terminal.
 *
 * The regression it exists for: shutdownAll() disposes every terminal on the
 * way out, so a capture running after it records an empty set over the one we
 * just saved — making a clean quit the single case that loses your terminals.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-restore-'));
const FAKE_HOME = path.join(ROOT, 'home');
const WORK = path.join(ROOT, 'work');
const STUB = path.join(FAKE_HOME, 'bin', 'claude');
const STATE = path.join(FAKE_HOME, '.claude-terminal', 'state.json');
const PORT = 7791;
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * Every /api call is token-gated, so this harness reads the token the server
 * wrote and attaches it. Shadowing `fetch` keeps the token out of the call
 * sites, which are about behaviour under test, not authentication.
 */
const TOKEN_FILE = path.join(FAKE_HOME, '.claude-terminal', 'token');
function ctToken(): string {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}
const fetch = (url: string, init: RequestInit = {}): Promise<Response> =>
  globalThis.fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), 'x-ct-token': ctToken() },
  });


let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const SESSIONS = [
  { id: '11111111-1111-4111-8111-111111111111', title: 'alpha work' },
  { id: '22222222-2222-4222-8222-222222222222', title: 'beta work' },
  { id: '33333333-3333-4333-8333-333333333333', title: 'gamma work' },
];

function scaffold(): void {
  const projects = path.join(FAKE_HOME, '.claude', 'projects', '-ct-restore-work');
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(path.join(FAKE_HOME, 'bin'), { recursive: true });
  fs.mkdirSync(WORK, { recursive: true });

  const now = Date.now();
  SESSIONS.forEach((s, i) => {
    const at = (off: number) => new Date(now - off).toISOString();
    const lines = [
      { type: 'custom-title', customTitle: s.title, cwd: WORK, timestamp: at(600_000 + i * 1000) },
      { type: 'user', message: { content: `do the ${s.title}` }, cwd: WORK, timestamp: at(500_000 + i * 1000) },
      { type: 'assistant', message: { stop_reason: 'end_turn' }, cwd: WORK, timestamp: at(400_000 + i * 1000) },
    ];
    fs.writeFileSync(
      path.join(projects, `${s.id}.jsonl`),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    );
  });

  // A `claude` that stays alive without doing anything. The terminal only has
  // to look live to the server; what runs inside it is irrelevant here.
  fs.writeFileSync(STUB, [
    '#!/bin/sh',
    'echo "stub claude: $*"',
    "trap 'exit 0' HUP TERM INT",
    'while :; do sleep 0.5; done',
    '',
  ].join('\n'));
  fs.chmodSync(STUB, 0o755);
  // cleanEnv() takes PATH from an interactive login shell, which is the only
  // place the stub can be injected — the same mechanism that makes `claude`
  // findable when the app is launched from Finder.
  fs.writeFileSync(path.join(FAKE_HOME, '.zshrc'), `export PATH="${path.dirname(STUB)}:$PATH"\n`);
  fs.writeFileSync(path.join(FAKE_HOME, '.zprofile'), '');
}

async function waitForUp(proc: ChildProcess, ms = 40_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (proc.exitCode !== null) throw new Error(`server exited early (${proc.exitCode})`);
    try {
      const res = await fetch(`${BASE}/api/sessions`);
      if (res.ok) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server never came up');
}

async function waitForDown(ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      await fetch(`${BASE}/api/sessions`);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('port never freed');
}

/** The server of the current lifetime, so a failed run does not leave it up. */
let running: ChildProcess | null = null;

function startServer(): ChildProcess {
  running = spawn('npx', ['tsx', 'server/cli.ts'], {
    cwd: REPO,
    env: { ...process.env, HOME: FAKE_HOME, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so one signal reaches every layer — see
    // signalServer().
    detached: true,
  });
  return running;
}

/**
 * `npx tsx` puts an npm-exec wrapper and a shell between us and node, and on
 * Linux neither forwards a signal: killing the pid we spawned kills the
 * wrapper and leaves the real server holding the port, which is exactly what
 * `waitForDown` then times out on. bin/claude-terminal documents the same
 * hazard and works around it by resolving the listener pid; here the child is
 * spawned detached, so signalling the group reaches the server itself and its
 * SIGTERM handler still runs — the flush-on-quit this test is about.
 */
function signalServer(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.pid === undefined) return;
  try {
    process.kill(-proc.pid, signal);
  } catch {
    proc.kill(signal); // group already gone
  }
}

/** A clean quit, the way the app quits: SIGTERM into cli.ts's handler. */
async function stopServer(proc: ChildProcess): Promise<void> {
  signalServer(proc, 'SIGTERM');
  await waitForDown();
  await new Promise((r) => setTimeout(r, 400));
  if (proc === running) running = null;
}

/** Last resort on the way out: never leave a detached server on the port. */
function killServer(): void {
  if (!running) return;
  signalServer(running, 'SIGKILL');
  running = null;
}

const api = {
  sessions: async (force = false) =>
    (await fetch(`${BASE}/api/sessions${force ? '?force=1' : ''}`)).json(),
  startTerm: (id: string) =>
    fetch(`${BASE}/api/terms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, sessionId: id, cwd: WORK, cols: 100, rows: 30 }),
    }),
  killTerm: (id: string) => fetch(`${BASE}/api/terms/${id}?hard=1`, { method: 'DELETE' }),
  clearRestore: () => fetch(`${BASE}/api/restore`, { method: 'DELETE' }),
};

function workingSetOnDisk(): { sessionId: string; cwd: string }[] {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8')).workingSet ?? [];
  } catch {
    return [];
  }
}

function killStubs(): void {
  try { execFileSync('pkill', ['-f', STUB], { stdio: 'ignore' }); } catch { /* none left */ }
}

const main = async () => {
  console.log(`restore: ${ROOT}\n`);
  scaffold();

  // ---- lifetime 1: open two terminals, then quit cleanly ----
  let proc = startServer();
  await waitForUp(proc);
  let payload = await api.sessions();
  check('synthetic sessions are scanned', payload.sessions.length === 3, `got ${payload.sessions.length}`);
  check('nothing to restore on a first run', payload.restore.length === 0, JSON.stringify(payload.restore));

  await api.startTerm(SESSIONS[0].id);
  await api.startTerm(SESSIONS[1].id);
  await new Promise((r) => setTimeout(r, 900));
  let ws = workingSetOnDisk();
  check('open terminals are recorded while running', ws.length === 2, JSON.stringify(ws));

  await stopServer(proc);
  ws = workingSetOnDisk();
  check('a clean quit KEEPS the working set', ws.length === 2, JSON.stringify(ws));
  check(
    'the right two sessions were kept',
    ws.map((e) => e.sessionId).sort().join(',') === [SESSIONS[0].id, SESSIONS[1].id].sort().join(','),
    JSON.stringify(ws),
  );

  // ---- lifetime 2: the offer, and taking it ----
  proc = startServer();
  await waitForUp(proc);
  payload = await api.sessions(true);
  check('both are offered for restore', payload.restore.length === 2, JSON.stringify(payload.restore));
  check(
    'the offer names them',
    payload.restore.map((r: any) => r.title).sort().join(',') === 'alpha work,beta work',
    JSON.stringify(payload.restore.map((r: any) => r.title)),
  );
  check('the offer carries a usable cwd', payload.restore.every((r: any) => r.cwd === WORK));

  // Sit idle long enough for several housekeeping ticks: the offer must not
  // erase itself by recording the (empty) live set over it.
  await new Promise((r) => setTimeout(r, 5_000));
  payload = await api.sessions(true);
  check('the offer survives idle housekeeping ticks', payload.restore.length === 2, JSON.stringify(payload.restore));
  check('an untaken offer is still on disk', workingSetOnDisk().length === 2, JSON.stringify(workingSetOnDisk()));

  // Quitting without acting on the offer must not consume it. Found by running
  // the packaged app twice: in memory the offer looked fine for the whole
  // first run, and only the SECOND launch revealed that the housekeeping tick
  // had already written an empty set over it.
  await stopServer(proc);
  check('an ignored offer survives the quit', workingSetOnDisk().length === 2, JSON.stringify(workingSetOnDisk()));
  proc = startServer();
  await waitForUp(proc);
  payload = await api.sessions(true);
  check('an ignored offer is made again next launch', payload.restore.length === 2, JSON.stringify(payload.restore));

  // Reopening them yourself, without touching the banner, must also settle the
  // offer — otherwise closing one of those terminals later re-offers it.
  await api.startTerm(payload.restore[0].sessionId);
  await new Promise((r) => setTimeout(r, 300));
  payload = await api.sessions(true);
  check('reopening one yourself drops it from the offer', payload.restore.length === 1, JSON.stringify(payload.restore));
  await api.killTerm(SESSIONS[0].id);
  await new Promise((r) => setTimeout(r, 300));
  payload = await api.sessions(true);
  check('closing it again does not resurrect the offer', payload.restore.length === 1, JSON.stringify(payload.restore));

  for (const r of payload.restore) await api.startTerm(r.sessionId);
  await api.clearRestore();
  payload = await api.sessions(true);
  check('the offer is gone once taken', payload.restore.length === 0, JSON.stringify(payload.restore));
  check(
    'the remaining session is attached again',
    payload.sessions.filter((s: any) => s.attached).length === 1,
    JSON.stringify(payload.sessions.filter((s: any) => s.attached).map((s: any) => s.title)),
  );

  // ---- lifetime 3: closing terminals yourself must not resurrect them ----
  for (const s of SESSIONS) await api.killTerm(s.id);
  await new Promise((r) => setTimeout(r, 600));
  check('closing every terminal empties the set', workingSetOnDisk().length === 0, JSON.stringify(workingSetOnDisk()));

  await stopServer(proc);
  proc = startServer();
  await waitForUp(proc);
  payload = await api.sessions(true);
  check('quitting with nothing open offers nothing', payload.restore.length === 0, JSON.stringify(payload.restore));

  // ---- lifetime 4: dismissing sticks ----
  await api.startTerm(SESSIONS[2].id);
  await new Promise((r) => setTimeout(r, 600));
  await stopServer(proc);
  proc = startServer();
  await waitForUp(proc);
  payload = await api.sessions(true);
  check('the third session is offered', payload.restore.length === 1, JSON.stringify(payload.restore));
  await api.clearRestore();
  payload = await api.sessions(true);
  check('dismissing clears the offer', payload.restore.length === 0);
  await stopServer(proc);
  proc = startServer();
  await waitForUp(proc);
  payload = await api.sessions(true);
  check('a dismissed offer does not come back', payload.restore.length === 0, JSON.stringify(payload.restore));
  await stopServer(proc);

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail;
};

main()
  .then((f) => { killServer(); killStubs(); fs.rmSync(ROOT, { recursive: true, force: true }); process.exit(f ? 1 : 0); })
  .catch((e) => { killServer(); killStubs(); console.error(e); console.error(`left ${ROOT} for inspection`); process.exit(1); });
