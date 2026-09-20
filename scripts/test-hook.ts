/**
 * The cleanup hook marks the right session, and never breaks a prompt:
 *   npm run test:hook
 *
 * `hooks/ct-cleanup-mark.sh` runs as a Claude Code UserPromptSubmit hook. It is
 * handed the prompt as typed and the session id on stdin, and when the prompt
 * is a cleanup invocation it PATCHes that session in this server — the same
 * write the `c` key makes.
 *
 * Two things have to hold, and the second matters more than the first:
 *
 *   - it marks on the cleanup command and NOT on prose that merely says
 *     "clean up", because a marker that lands on the wrong sessions is worse
 *     than no marker at all
 *   - it exits 0 and stays silent on every failure it can meet — no server, no
 *     token, an unknown session, a payload it cannot parse. This hook sits in
 *     front of every prompt the user types, so a non-zero exit or a stray line
 *     on stdout is a broken session, not a missed marker.
 *
 * Self-contained: a throwaway HOME with synthetic transcripts and its own
 * server on its own port. Claude Code is never started and the real
 * ~/.claude-terminal is never touched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOK = path.join(REPO, 'hooks', 'ct-cleanup-mark.sh');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-hook-'));
const FAKE_HOME = path.join(ROOT, 'home');
const PORT = 7795;
const BASE = `http://127.0.0.1:${PORT}`;

/** Marked by the fixture; the hook must leave it alone and never clear it. */
const MARKED = 'aaaaaaaa-1111-4111-8111-000000000001';
/** Unmarked; every "does it mark" assertion works on this one. */
const PLAIN = 'bbbbbbbb-2222-4222-8222-000000000002';
const UNKNOWN = 'cccccccc-3333-4333-8333-000000000003';

function ctToken(): string {
  try {
    return fs.readFileSync(path.join(FAKE_HOME, '.claude-terminal', 'token'), 'utf8').trim();
  } catch {
    return '';
  }
}

const fetch = (url: string, init: RequestInit = {}): Promise<Response> =>
  globalThis.fetch(url, { ...init, headers: { ...(init.headers ?? {}), 'x-ct-token': ctToken() } });

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

function scaffold(): void {
  fs.mkdirSync(path.join(FAKE_HOME, '.claude', 'sessions'), { recursive: true });
  const now = Date.now();
  for (const id of [MARKED, PLAIN]) {
    const cwd = path.join(FAKE_HOME, 'repos', id.slice(0, 4));
    fs.mkdirSync(cwd, { recursive: true });
    const dir = path.join(FAKE_HOME, '.claude', 'projects', cwd.replace(/\//g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), [
      JSON.stringify({
        type: 'user', sessionId: id, cwd, version: '1.0.0',
        timestamp: new Date(now - 3_600_000).toISOString(),
        message: { role: 'user', content: 'do some work' },
      }),
      JSON.stringify({
        type: 'assistant', sessionId: id, cwd,
        timestamp: new Date(now - 60_000).toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
      }),
    ].join('\n') + '\n');
  }
  fs.mkdirSync(path.join(FAKE_HOME, '.claude-terminal'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(FAKE_HOME, '.claude-terminal', 'state.json'),
    JSON.stringify({ version: 1, sessions: { [MARKED]: { tags: [], cleanup: true } }, workingSet: [] }, null, 2),
    { mode: 0o600 },
  );
}

async function waitForUp(proc: ChildProcess, ms = 40_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (proc.exitCode !== null) throw new Error(`server exited early (${proc.exitCode})`);
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server never came up');
}

/** Whether the server currently holds a cleanup mark for `id`. */
async function marked(id: string): Promise<boolean> {
  const payload: any = await (await fetch(`${BASE}/api/sessions?force=1`)).json();
  return !!payload.sessions.find((s: any) => s.id === id)?.user.cleanup;
}

/** Put a session back to a known mark, so the next assertion starts from it. */
async function setMark(id: string, cleanup: boolean): Promise<void> {
  await fetch(`${BASE}/api/sessions/${id}/state`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cleanup }),
  });
}

interface Run { code: number; stdout: string; stderr: string; ms: number }

/**
 * Run the hook exactly as Claude Code does: JSON on stdin, nothing else.
 *
 * Both streams are captured rather than inherited, because "says nothing" is
 * half of what is being asserted — a hook that prints interrupts the prompt it
 * is standing in front of.
 */
function runHook(payload: string, env: Record<string, string> = {}): Run {
  const started = Date.now();
  const res = spawnSync('bash', [HOOK], {
    input: payload,
    env: { ...process.env, HOME: FAKE_HOME, CT_PORT: String(PORT), ...env },
    encoding: 'utf8',
  });
  return {
    // A signalled or unspawnable child reports a null status; neither is a
    // pass, so it must not collapse to 0.
    code: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    ms: Date.now() - started,
  };
}

const body = (prompt: string, sessionId: string | null = PLAIN) =>
  JSON.stringify(sessionId === null ? { prompt } : { prompt, session_id: sessionId });

const main = async () => {
  console.log(`hook: ${ROOT}\n`);
  scaffold();

  const proc = spawn('npx', ['tsx', 'server/cli.ts'], {
    cwd: REPO,
    env: { ...process.env, HOME: FAKE_HOME, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  try {
    await waitForUp(proc);
    check('the fixture starts with one session marked and one not',
      (await marked(MARKED)) && !(await marked(PLAIN)));

    // ---------------------------------------------------------- what it marks
    let r = runHook(body('/cleanup'));
    check('the cleanup command marks the session', r.code === 0 && (await marked(PLAIN)));

    r = runHook(body('/cleanup wrap this up and archive it'));
    check('  arguments after it do not stop it matching', r.code === 0 && (await marked(PLAIN)));

    // ------------------------------------------------------ what it must NOT
    // The whole point of the narrow trigger. A marker that lands on sessions
    // you did not clean up makes the filter useless, which is worse than
    // having to press `c` yourself.
    const notTriggers = [
      'clean up the dead code in utils.ts',
      'why is /cleanup not firing?',
      'run the cleanup command for me',
      'cleanup',
      '/cleanupsomething',
    ];
    for (const prompt of notTriggers) {
      // Against a REAL, currently-unmarked session, so the assertion is the
      // absence of the write itself. Pointed at an id the server does not know,
      // this would pass even with the trigger broken wide open: the PATCH would
      // 404 and the hook would still exit 0 in silence.
      await setMark(PLAIN, false);
      const res = runHook(body(prompt));
      check(`does not fire on ${JSON.stringify(prompt)}`,
        res.code === 0 && res.stdout === '' && res.stderr === '' && !(await marked(PLAIN)),
        `code=${res.code} out=${res.stdout} err=${res.stderr} marked=${await marked(PLAIN)}`);
    }

    // --------------------------------------------- never breaks the prompt
    // Every one of these is a state a real machine reaches. The hook runs in
    // front of every prompt, so all of them must be silent no-ops.
    const survivable: [string, string, Record<string, string>][] = [
      ['the app is not running', body('/cleanup'), { CT_PORT: '7794' }],
      ['there is no token file', body('/cleanup'), { HOME: path.join(ROOT, 'nowhere') }],
      ['the session is unknown to the server', body('/cleanup', UNKNOWN), {}],
      ['the payload is not JSON', 'not json at all', {}],
      ['stdin is empty', '', {}],
      ['the payload carries no session id', body('/cleanup', null), {}],
    ];
    for (const [what, payload, env] of survivable) {
      const res = runHook(payload, env);
      check(`survives: ${what}`,
        res.code === 0 && res.stdout === '' && res.stderr === '',
        `code=${res.code} out=${JSON.stringify(res.stdout)} err=${JSON.stringify(res.stderr)}`);
      check(`  and returns promptly (${res.ms}ms)`, res.ms < 8_000, `${res.ms}ms`);
    }

    // ------------------------------------------------------------ idempotence
    const before = await marked(MARKED);
    r = runHook(body('/cleanup', MARKED));
    check('marking an already-marked session leaves it marked',
      r.code === 0 && before && (await marked(MARKED)));
  } finally {
    try {
      if (proc.pid !== undefined) process.kill(-proc.pid, 'SIGTERM');
    } catch {
      proc.kill('SIGTERM'); // group already gone
    }
    await new Promise((r) => setTimeout(r, 600));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail;
};

main()
  .then((f) => { fs.rmSync(ROOT, { recursive: true, force: true }); process.exit(f ? 1 : 0); })
  .catch((e) => { console.error(e); console.error(`left ${ROOT} for inspection`); process.exit(1); });
