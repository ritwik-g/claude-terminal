/**
 * Keep-warm through the real server:  npm run test:keepwarm-routes
 *
 * test-keepwarm.ts pins the rules with a fake clock. This one checks that the
 * wiring between them holds: the routes, keystrokes arriving over the real
 * terminal socket, the housekeeping tick, and the ping reaching a real PTY as
 * one submitted line — against a throwaway HOME and a stub `claude` that turns
 * each line it is given into a transcript turn, the way Claude Code would.
 *
 * The transcript's last turn is placed 50 minutes back, so a ping is due the
 * moment keep-warm is on and nothing here has to wait out the real 45 minutes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { PING_TEXT } from '../server/keepwarm.js';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-keepwarm-routes-'));
const FAKE_HOME = path.join(ROOT, 'home');
const WORK = path.join(ROOT, 'work');
const STUB = path.join(FAKE_HOME, 'bin', 'claude');
const INPUT_LOG = path.join(FAKE_HOME, 'stub-input.log');
const PROJECTS = path.join(FAKE_HOME, '.claude', 'projects', '-ct-keepwarm-work');
const PORT = 7798;
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'cccccccc-3333-4333-8333-333333333333';
const IDLE = 'dddddddd-4444-4444-8444-444444444444';

const TOKEN_FILE = path.join(FAKE_HOME, '.claude-terminal', 'token');
const token = () => { try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return ''; } };
const fetch = (url: string, init: RequestInit = {}): Promise<Response> =>
  globalThis.fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}), 'x-ct-token': token() },
  });

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const MIN = 60_000;
const now = Date.now();
const iso = (t: number) => new Date(t).toISOString();

function scaffold(): void {
  fs.mkdirSync(PROJECTS, { recursive: true });
  fs.mkdirSync(path.join(FAKE_HOME, '.claude', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(FAKE_HOME, 'bin'), { recursive: true });
  fs.mkdirSync(WORK, { recursive: true });

  for (const id of [SID, IDLE]) {
    fs.writeFileSync(path.join(PROJECTS, `${id}.jsonl`), [
      { type: 'custom-title', customTitle: `kept warm ${id.slice(0, 4)}`, cwd: WORK, timestamp: iso(now - 60 * MIN) },
      { type: 'user', cwd: WORK, timestamp: iso(now - 60 * MIN), origin: { kind: 'human' }, promptSource: 'typed',
        message: { role: 'user', content: 'the real question' } },
      { type: 'last-prompt', lastPrompt: 'the real question' },
      { type: 'assistant', cwd: WORK, timestamp: iso(now - 50 * MIN),
        message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'answer' }],
          usage: { input_tokens: 3, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 900 } } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  // A stand-in for Claude Code: registers itself the way the real one does,
  // then turns every line it reads into a user turn and a reply that read the
  // cache. The PTY's line discipline does the rest — Enter submits a line, and
  // Backspace erases in it — so this is the same "what is in the input box"
  // question the feature is about, answered by a real terminal.
  fs.writeFileSync(STUB, `#!${process.execPath}
const fs = require('fs'), path = require('path'), os = require('os');
const sid = process.argv[process.argv.indexOf('--resume') + 1];
const home = os.homedir();
const proj = path.join(home, '.claude', 'projects');
const file = fs.readdirSync(proj).map((d) => path.join(proj, d, sid + '.jsonl')).find((f) => fs.existsSync(f));
fs.writeFileSync(path.join(home, '.claude', 'sessions', process.pid + '.json'), JSON.stringify({
  pid: process.pid, sessionId: sid, status: 'idle', name: 'stub', startedAt: Date.now(), statusUpdatedAt: Date.now(),
}));
process.on('SIGHUP', () => process.exit(0));
const rl = require('readline').createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  fs.appendFileSync(path.join(home, 'stub-input.log'), JSON.stringify({ sid, line }) + '\\n');
  const t = Date.now();
  const recs = [
    { type: 'user', timestamp: new Date(t).toISOString(), origin: { kind: 'human' }, promptSource: 'typed',
      message: { role: 'user', content: line } },
    { type: 'last-prompt', lastPrompt: line },
    { type: 'assistant', timestamp: new Date(t + 5).toISOString(),
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 2, cache_read_input_tokens: 81000, cache_creation_input_tokens: 60 } } },
  ];
  fs.appendFileSync(file, recs.map((r) => JSON.stringify(r)).join('\\n') + '\\n');
});
`);
  fs.chmodSync(STUB, 0o755);
  fs.writeFileSync(path.join(FAKE_HOME, '.zshrc'), `export PATH="${path.dirname(STUB)}:$PATH"\n`);
  fs.writeFileSync(path.join(FAKE_HOME, '.zprofile'), '');
  fs.writeFileSync(path.join(FAKE_HOME, '.bashrc'), `export PATH="${path.dirname(STUB)}:$PATH"\n`);
  fs.writeFileSync(path.join(FAKE_HOME, '.bash_profile'), `export PATH="${path.dirname(STUB)}:$PATH"\n`);
}

const inputs = (sid: string): string[] => {
  try {
    return fs.readFileSync(INPUT_LOG, 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).filter((e) => e.sid === sid).map((e) => e.line);
  } catch { return []; }
};

async function waitForUp(proc: ChildProcess, ms = 40_000): Promise<void> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (proc.exitCode !== null) throw new Error(`server exited early (${proc.exitCode})`);
    try { if ((await fetch(`${BASE}/api/sessions`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server never came up');
}

async function until(what: () => Promise<boolean> | boolean, ms = 12_000): Promise<boolean> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await what()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const session = async (id: string): Promise<any> =>
  (await (await fetch(`${BASE}/api/sessions?force=1`)).json()).sessions.find((s: any) => s.id === id);

const enable = (id: string, body: object) =>
  fetch(`${BASE}/api/sessions/${id}/keepwarm`, { method: 'POST', body: JSON.stringify(body) });

function socket(termId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/term?id=${termId}&token=${token()}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

const main = async () => {
  console.log(`keep-warm routes: ${ROOT}\n`);
  scaffold();
  const proc = spawn('npx', ['tsx', 'server/cli.ts'], {
    cwd: REPO,
    env: { ...process.env, HOME: FAKE_HOME, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  try {
    await waitForUp(proc);
    await session(SID);

    // ---- validation ----
    const bad = await enable(SID, { minutes: 5, untilSend: false, pausePct: null });
    check('a duration below the minimum is refused', bad.status === 400, String(bad.status));
    const unknown = await enable('eeeeeeee-5555-4555-8555-555555555555', { minutes: 120, untilSend: false, pausePct: null });
    check('an unknown session is refused', unknown.status === 404, String(unknown.status));
    const noTerm = await enable(SID, { minutes: 120, untilSend: false, pausePct: null });
    check('a session with no terminal of ours is refused', noTerm.status === 409, String(noTerm.status));

    // ---- open it the way the UI does ----
    for (const id of [SID, IDLE]) {
      await fetch(`${BASE}/api/terms`, {
        method: 'POST',
        body: JSON.stringify({ id, sessionId: id, cwd: WORK, cols: 100, rows: 30 }),
      });
    }
    check('the stub registers as idle', await until(async () => (await session(SID))?.live?.status === 'idle'),
      JSON.stringify((await session(SID))?.live));
    const ws = await socket(SID);

    // ---- typing left unsent turns it off ----
    const on = await enable(SID, { minutes: 120, untilSend: false, pausePct: null });
    check('keep-warm turns on for a session running in our terminal', on.ok, String(on.status));
    // Terminal reports (focus, mouse) are covered in test-keepwarm.ts: the stub
    // reads in cooked mode, where one would sit in the line buffer as text —
    // unlike Claude Code, which reads raw and handles them itself.
    ws.send(JSON.stringify({ type: 'input', data: 'x' }));
    check('a draft in the input box turns keep-warm off at the due ping',
      await until(async () => (await session(SID))?.keepWarm?.stopped?.reason === 'typed'),
      JSON.stringify((await session(SID))?.keepWarm));
    check('  and nothing was typed on top of it', inputs(SID).length === 0, JSON.stringify(inputs(SID)));

    // ---- cleared and turned back on, the ping lands as its own line ----
    ws.send(JSON.stringify({ type: 'input', data: '\x7f' }));
    await new Promise((r) => setTimeout(r, 300));
    const again = await enable(SID, { minutes: 120, untilSend: false, pausePct: null });
    check('turning it back on is accepted', again.ok, String(again.status));
    check('the ping arrives as one submitted line, exactly',
      await until(() => inputs(SID).length > 0) && inputs(SID)[0] === PING_TEXT, JSON.stringify(inputs(SID)));
    check('the reply is read as a cache hit',
      await until(async () => (await session(SID))?.keepWarm?.lastResult === 'hit'),
      JSON.stringify((await session(SID))?.keepWarm));
    const s = await session(SID);
    check('  and counted once', s.keepWarm.pings === 1, String(s.keepWarm.pings));
    check('the ping does not move the session\'s activity time',
      Math.abs(s.lastActivity - (now - 50 * MIN)) < 1000, iso(s.lastActivity));
    check('  or become its last prompt', s.lastPrompt === 'the real question', s.lastPrompt);
    check('  or land it in Working or as an unseen completion',
      !(await (await fetch(`${BASE}/api/sessions?force=1`)).json()).completions.some((c: any) => c.sessionId === SID));
    check('the next ping is timed from the reply, not the old turn',
      s.keepWarm.nextPingAt > now + 40 * MIN, iso(s.keepWarm.nextPingAt));
    ws.close();

    // ---- the manual override, and turning it off ----
    const idleOn = await enable(IDLE, { minutes: 120, untilSend: false, pausePct: null });
    check('a second session can be kept warm alongside', idleOn.ok);
    await until(() => inputs(IDLE).length > 0);
    // One ping out at a time: Ping anyway waits for the first one's reply.
    await until(async () => (await session(IDLE))?.keepWarm?.awaitingReply === false);
    const ping = await fetch(`${BASE}/api/sessions/${IDLE}/keepwarm/ping`, { method: 'POST' });
    check('Ping anyway sends another', ping.ok && (await until(() => inputs(IDLE).length === 2)),
      `${ping.status} ${JSON.stringify(inputs(IDLE))}`);
    const off = await fetch(`${BASE}/api/sessions/${IDLE}/keepwarm`, { method: 'DELETE' });
    check('turning it off forgets it', off.ok && (await session(IDLE)).keepWarm === null);
    const late = await fetch(`${BASE}/api/sessions/${IDLE}/keepwarm/ping`, { method: 'POST' });
    check('  and Ping anyway is refused once it is off', late.status === 409, String(late.status));

    // ---- snoozing ----
    const snooze = (id: string, until: number) =>
      fetch(`${BASE}/api/sessions/${id}/state`, { method: 'PATCH', body: JSON.stringify({ snoozedUntil: until }) });
    await enable(IDLE, { minutes: 120, untilSend: false, pausePct: null });
    await snooze(IDLE, Date.now() + 60 * MIN);
    check('a snooze inside keep-warm\'s time leaves it on', (await session(IDLE))?.keepWarm?.active === true);
    await snooze(IDLE, Date.now() + 24 * 60 * MIN);
    const snoozed = (await session(IDLE))?.keepWarm;
    check('one past it stops keep-warm and says why', snoozed?.stopped?.reason === 'snoozed', JSON.stringify(snoozed));

    // ---- a closed terminal ----
    await fetch(`${BASE}/api/terms/${SID}?hard=1`, { method: 'DELETE' });
    check('closing the terminal stops keep-warm and says why',
      await until(async () => (await session(SID))?.keepWarm?.stopped?.reason === 'terminal-closed'),
      JSON.stringify((await session(SID))?.keepWarm));
  } finally {
    try {
      if (proc.pid !== undefined) process.kill(-proc.pid, 'SIGTERM');
    } catch {
      proc.kill('SIGTERM');
    }
    await new Promise((r) => setTimeout(r, 400));
    try { execFileSync('pkill', ['-f', STUB], { stdio: 'ignore' }); } catch { /* none left */ }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail;
};

main()
  .then((f) => { fs.rmSync(ROOT, { recursive: true, force: true }); process.exit(f ? 1 : 0); })
  .catch((e) => { console.error(e); console.error(`left ${ROOT} for inspection`); process.exit(1); });
