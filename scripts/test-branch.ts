/**
 * A terminal follows its session across a `/branch`:  npm run test:branch
 *
 * `/branch` forks a session into a NEW id inside the same process. The PTY
 * that started out running session A is now running B, and Claude Code
 * rewrites ~/.claude/sessions/<pid>.json to say so.
 *
 * The app used to learn a terminal's session id exactly once. After a branch
 * it still believed the terminal held A, so B — the session you were actually
 * sitting in — had no terminal at all and the pane announced "Running in
 * another terminal" about the very terminal you were typing into.
 *
 * Self-contained: a throwaway HOME with synthetic transcripts, a stub `claude`
 * on the PATH, and a registry this test writes itself to stand in for the
 * branch. Nothing here touches ~/.claude or ~/.claude-terminal.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-branch-'));
const FAKE_HOME = path.join(ROOT, 'home');
const WORK = path.join(ROOT, 'work');
const STUB = path.join(FAKE_HOME, 'bin', 'claude');
const LIVE_DIR = path.join(FAKE_HOME, '.claude', 'sessions');
const PROJECTS = path.join(FAKE_HOME, '.claude', 'projects', '-ct-branch-work');
const PORT = 7794;
const BASE = `http://127.0.0.1:${PORT}`;

const PARENT = 'aaaaaaaa-1111-4111-8111-111111111111';
const BRANCHED = 'bbbbbbbb-2222-4222-8222-222222222222';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const now = Date.now();
const at = (off: number) => new Date(now - off).toISOString();

function transcript(id: string, title: string): void {
  fs.writeFileSync(path.join(PROJECTS, `${id}.jsonl`), [
    { type: 'custom-title', customTitle: title, cwd: WORK, timestamp: at(600_000) },
    { type: 'user', message: { role: 'user', content: 'go' }, cwd: WORK, timestamp: at(500_000) },
    { type: 'assistant', message: { stop_reason: 'end_turn' }, cwd: WORK, timestamp: at(400_000) },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function scaffold(): void {
  fs.mkdirSync(PROJECTS, { recursive: true });
  fs.mkdirSync(LIVE_DIR, { recursive: true });
  fs.mkdirSync(path.join(FAKE_HOME, 'bin'), { recursive: true });
  fs.mkdirSync(WORK, { recursive: true });

  transcript(PARENT, 'parent session');
  // The branch's transcript exists from the moment it is created, the same way
  // Claude Code writes one; the app can only adopt a session it can see.
  transcript(BRANCHED, 'branched session');

  fs.writeFileSync(STUB, [
    '#!/bin/sh',
    'echo "stub claude: $*"',
    "trap 'exit 0' HUP TERM INT",
    'while :; do sleep 0.5; done',
    '',
  ].join('\n'));
  fs.chmodSync(STUB, 0o755);
  fs.writeFileSync(path.join(FAKE_HOME, '.zshrc'), `export PATH="${path.dirname(STUB)}:$PATH"\n`);
  fs.writeFileSync(path.join(FAKE_HOME, '.zprofile'), '');
}

/**
 * Stand in for Claude Code's own registry. One file per pid is the property
 * the fix leans on: the pid resolves to exactly one CURRENT session, so
 * re-reading it can never oscillate between two ids.
 */
function writeRegistry(pid: number, sessionId: string): void {
  for (const f of fs.readdirSync(LIVE_DIR)) fs.rmSync(path.join(LIVE_DIR, f));
  fs.writeFileSync(path.join(LIVE_DIR, `${pid}.json`), JSON.stringify({
    pid,
    sessionId,
    status: 'idle',
    name: 'stub',
    startedAt: Date.now(),
    statusUpdatedAt: Date.now(),
  }));
}

async function waitForUp(proc: ChildProcess, ms = 40_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (proc.exitCode !== null) throw new Error(`server exited early (${proc.exitCode})`);
    try {
      if ((await fetch(`${BASE}/api/sessions`)).ok) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server never came up');
}

const sessions = async (): Promise<any> =>
  (await fetch(`${BASE}/api/sessions?force=1`)).json();

/** Poll rather than sleep a fixed time: adoption runs on the housekeeping tick. */
async function until(what: () => Promise<boolean>, ms = 12_000): Promise<boolean> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await what()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

const main = async () => {
  console.log(`branch: ${ROOT}\n`);
  scaffold();

  const proc = spawn('npx', ['tsx', 'server/cli.ts'], {
    cwd: REPO,
    env: { ...process.env, HOME: FAKE_HOME, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForUp(proc);
    check('both sessions are scanned', (await sessions()).sessions.length === 2);

    // Open a terminal on the parent, the way the UI does.
    await fetch(`${BASE}/api/terms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: PARENT, sessionId: PARENT, cwd: WORK, cols: 100, rows: 30 }),
    });
    await new Promise((r) => setTimeout(r, 700));

    const terms = await (await fetch(`${BASE}/api/terms`)).json();
    const term = terms.terms.find((t: any) => t.id === PARENT);
    check('the terminal is running', !!term && !term.exited);
    const pid: number = term.pid;
    check('it reports a pid to match the registry against', typeof pid === 'number' && pid > 0);

    let payload = await sessions();
    const by = (id: string) => payload.sessions.find((s: any) => s.id === id);
    check('the parent is attached', by(PARENT)?.attached === true);
    check('the branch is not attached yet', by(BRANCHED)?.attached === false);

    // ---- the branch: same process, new session id ----
    writeRegistry(pid, BRANCHED);

    const adopted = await until(async () => {
      payload = await sessions();
      return by(BRANCHED)?.attached === true;
    });
    check('the terminal follows the branch', adopted,
      JSON.stringify({ branched: by(BRANCHED)?.attached, parent: by(PARENT)?.attached }));

    payload = await sessions();
    check('  and the branch points at that terminal', by(BRANCHED)?.termId === PARENT,
      String(by(BRANCHED)?.termId));
    // The whole point: without this the pane says "Running in another terminal"
    // about the terminal you are sitting in.
    check('the parent stops claiming the terminal', by(PARENT)?.attached === false,
      JSON.stringify(by(PARENT)?.attached));

    const t2 = await (await fetch(`${BASE}/api/terms`)).json();
    check('the term record itself now names the branch',
      t2.terms.find((t: any) => t.id === PARENT)?.sessionId === BRANCHED,
      t2.terms.find((t: any) => t.id === PARENT)?.sessionId);

    // The two facts the "Active only" filter consumes. Before the fix the
    // parent held the terminal while looking dormant, and the branch — the
    // session actually running — was the one disowned.
    check('the branch counts as active (live or attached)',
      !!by(BRANCHED)?.live || by(BRANCHED)?.attached === true,
      JSON.stringify({ live: !!by(BRANCHED)?.live, attached: by(BRANCHED)?.attached }));
    check('the parent no longer counts as active',
      !by(PARENT)?.live && by(PARENT)?.attached === false,
      JSON.stringify({ live: !!by(PARENT)?.live, attached: by(PARENT)?.attached }));

    // Re-reading an unchanged registry must not thrash the mapping.
    await new Promise((r) => setTimeout(r, 3_000));
    payload = await sessions();
    check('it stays put across further ticks',
      by(BRANCHED)?.attached === true && by(PARENT)?.attached === false);

    // ---- the slash-command route the Branch and Rename buttons drive ----
    const cmd = (body: unknown) =>
      fetch(`${BASE}/api/terms/${PARENT}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    let r = await cmd({ command: 'branch' });
    check('branch is accepted', r.status === 200, String(r.status));
    check('  and sends exactly /branch', (await r.json()).sent === '/branch');

    r = await cmd({ command: 'rename', arg: 'a better name' });
    check('rename is accepted', r.status === 200, String(r.status));
    check('  and sends the name it was given', (await r.json()).sent === '/rename a better name');

    // A newline would submit early and leave the rest sitting at the prompt as
    // though it had been typed — the one input that must not survive intact.
    r = await cmd({ command: 'rename', arg: 'evil\nrm -rf /' });
    check('a newline in a rename is neutralised',
      (await r.json()).sent === '/rename evil rm -rf /');

    check('an unknown command is refused', (await cmd({ command: 'shell' })).status === 400);
    check('a non-string command is refused', (await cmd({ command: 42 })).status === 400);
    check('rename with no argument is refused', (await cmd({ command: 'rename' })).status === 400);
    check('rename with only control characters is refused',
      (await cmd({ command: 'rename', arg: '\u0007\u0000 ' })).status === 400);

    const gone = await fetch(`${BASE}/api/terms/${BRANCHED}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'branch' }),
    });
    check('a terminal that is not running answers 409', gone.status === 409, String(gone.status));
  } finally {
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 600));
    try { execFileSync('pkill', ['-f', STUB], { stdio: 'ignore' }); } catch { /* none left */ }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail;
};

main()
  .then((f) => { fs.rmSync(ROOT, { recursive: true, force: true }); process.exit(f ? 1 : 0); })
  .catch((e) => { console.error(e); console.error(`left ${ROOT} for inspection`); process.exit(1); });
