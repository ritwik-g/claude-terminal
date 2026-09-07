/**
 * The 'blocked' state:  npm run test:blocked
 *
 * A session stopped ON a question is the single most forgettable thing this
 * tool tracks, and before this state existed it was actively mislabelled: a
 * dead session holding an unanswered AskUserQuestion has a dangling tool_use,
 * so it read as `crashed` — "stopped mid tool-call" — which is the opposite of
 * the truth. Nothing crashed. You walked away from a question.
 *
 * Two independent signals feed it and both are checked here end-to-end against
 * a throwaway HOME: Claude Code's own `status: "waiting"` in the live registry
 * (covers permission prompts, which leave no transcript trace), and a dangling
 * question tool in the transcript (covers dead sessions, which the registry has
 * long since forgotten).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { score } from '../server/rank.js';
import type { LiveInfo, TailInfo } from '../server/types.js';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-blocked-'));
const FAKE_HOME = path.join(ROOT, 'home');
const WORK = path.join(ROOT, 'work');
const PORT = 7795;
const BASE = `http://127.0.0.1:${PORT}`;

const TOKEN_FILE = path.join(FAKE_HOME, '.claude-terminal', 'token');
const fetch = (url: string, init: RequestInit = {}): Promise<Response> =>
  globalThis.fetch(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      'x-ct-token': (() => { try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return ''; } })(),
    },
  });

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const S = {
  question: '11111111-1111-4111-8111-aaaaaaaaaaaa',
  plan: '22222222-2222-4222-8222-aaaaaaaaaaaa',
  midBash: '33333333-3333-4333-8333-aaaaaaaaaaaa',
  answered: '44444444-4444-4444-8444-aaaaaaaaaaaa',
  permission: '55555555-5555-4555-8555-aaaaaaaaaaaa',
  freshIdle: '66666666-6666-4666-8666-aaaaaaaaaaaa',
  noStatus: '77777777-7777-4777-8777-aaaaaaaaaaaa',
  articleless: '88888888-8888-4888-8888-aaaaaaaaaaaa',
};

const PROJECTS = path.join(FAKE_HOME, '.claude', 'projects', '-ct-blocked-work');
const LIVE = path.join(FAKE_HOME, '.claude', 'sessions');

const now = Date.now();
const at = (offMs: number) => new Date(now - offMs).toISOString();

function write(id: string, lines: unknown[]): void {
  fs.writeFileSync(
    path.join(PROJECTS, `${id}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
}

const head = (title: string, off: number) => [
  { type: 'custom-title', customTitle: title, cwd: WORK, timestamp: at(off) },
  { type: 'user', message: { role: 'user', content: 'do the thing' }, cwd: WORK, timestamp: at(off) },
];

const asks = (off: number, question: string) => ({
  type: 'assistant',
  message: {
    role: 'assistant',
    stop_reason: 'tool_use',
    content: [{
      type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion',
      input: { questions: [{ question, header: 'pick', multiSelect: false, options: [
        { label: 'A', description: 'first' }, { label: 'B', description: 'second' },
      ] }] },
    }],
  },
  cwd: WORK,
  timestamp: at(off),
});

function scaffold(): void {
  fs.mkdirSync(PROJECTS, { recursive: true });
  fs.mkdirSync(LIVE, { recursive: true });
  fs.mkdirSync(WORK, { recursive: true });

  // Dead, and the last thing it did was ask. Three weeks stale on purpose: the
  // ordering check below is only meaningful if recency is working against it.
  const OLD = 21 * 24 * 3600_000;
  write(S.question, [...head('unanswered question', OLD), asks(OLD, 'Which approach should we take here?')]);

  // A plan waiting for approval is the same shape of block.
  write(S.plan, [...head('unapproved plan', 7200_000), {
    type: 'assistant',
    message: {
      role: 'assistant', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_p', name: 'ExitPlanMode', input: { plan: 'step one' } }],
    },
    cwd: WORK, timestamp: at(7200_000),
  }]);

  // Also a dangling tool_use, but nothing asked anything. Still a crash.
  write(S.midBash, [...head('died mid bash', 7200_000), {
    type: 'assistant',
    message: {
      role: 'assistant', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'sleep 1' } }],
    },
    cwd: WORK, timestamp: at(7200_000),
  }]);

  // Asked AND answered: the tool_result settles it, so it is not blocked.
  write(S.answered, [
    ...head('answered question', 7200_000),
    asks(7300_000, 'Which approach should we take here?'),
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_q', content: 'Your questions have been answered.' }] },
      cwd: WORK, timestamp: at(7250_000),
    },
    { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] }, cwd: WORK, timestamp: at(7200_000) },
  ]);

  // These three end cleanly. Everything that separates them comes from the
  // live registry, which is exactly what is under test.
  for (const [id, title] of [
    [S.permission, 'stopped on a permission prompt'],
    [S.freshIdle, 'finished its turn'],
    [S.noStatus, 'just launched'],
    [S.articleless, 'stopped on an article-less label'],
  ] as const) {
    write(id, [...head(title, 60_000), {
      type: 'assistant',
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
      cwd: WORK, timestamp: at(60_000),
    }]);
  }

  /**
   * Registry entries for a process that is genuinely alive — our own. `pid` is
   * all that liveness checks, and omitting `procStart` takes the documented
   * fail-open path, so this exercises the real readLiveSessions rather than a
   * stub of it.
   */
  const reg = (pid: number, sessionId: string, extra: Record<string, unknown>) =>
    fs.writeFileSync(path.join(LIVE, `${pid}.json`), JSON.stringify({
      pid, sessionId, cwd: WORK, startedAt: now - 60_000, updatedAt: now,
      statusUpdatedAt: now, name: '', kind: 'interactive', ...extra,
    }));

  reg(spawnHolder(), S.permission, { status: 'waiting', waitingFor: 'permission prompt' });
  reg(spawnHolder(), S.freshIdle, { status: 'idle' });
  // No `status` key at all — what the sdk-cli entrypoint writes before its
  // first report. Must not be read as idle.
  reg(spawnHolder(), S.noStatus, {});
  // 'input needed' takes no article, unlike 'permission prompt'. Building a
  // sentence around these labels produced "stopped on a input needed" on a
  // real session; this pins the verbatim form that cannot go wrong.
  reg(spawnHolder(), S.articleless, { status: 'waiting', waitingFor: 'input needed' });
}

/**
 * A registry entry is only honoured if its pid is genuinely alive, so the
 * fixtures need real processes to point at. An arbitrary low pid does NOT
 * work — pid 2 does not exist on macOS, and using it made a case silently pass
 * through as un-blocked rather than fail loudly.
 */
const holders: ChildProcess[] = [];
function spawnHolder(): number {
  const p = spawn('sleep', ['300'], { stdio: 'ignore' });
  holders.push(p);
  if (!p.pid) throw new Error('could not spawn a holder process');
  return p.pid;
}

async function waitForUp(proc: ChildProcess, ms = 40_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (proc.exitCode !== null) throw new Error(`server exited early (${proc.exitCode})`);
    try { if ((await fetch(`${BASE}/api/sessions`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server never came up');
}

/** The score model, exercised directly — no server, no filesystem. */
function orderingChecks(): void {
  const tail = (over: Partial<TailInfo> = {}): TailInfo => ({
    lastStopReason: null, lastRole: 'assistant', lastUserWasToolResult: false,
    endedMidTool: false, pendingTools: [], pendingQuestion: null, ...over,
  });
  const base = {
    git: null,
    user: { tags: [], note: '', pinned: false, archived: false } as any,
    ownsCwd: true,
    now,
  };

  // The worst case for the ordering claim: a question abandoned three weeks
  // ago, against a session that wants you RIGHT NOW and is carrying every
  // score boost the model can hand out short of a human marking it.
  const stale = score({
    ...base,
    tail: tail({ endedMidTool: true, pendingTools: ['AskUserQuestion'], pendingQuestion: 'which?' }),
    live: null,
    lastActivity: now - 21 * 24 * 3600_000,
    hasPr: false,
  });
  const freshest = score({
    ...base,
    tail: tail({ lastStopReason: 'end_turn' }),
    live: { pid: 1, status: 'idle', name: '', statusUpdatedAt: now, startedAt: now } as LiveInfo,
    git: { branch: 'x', dirty: 99, ahead: 9, behind: 0, isWorktree: true, exists: true },
    lastActivity: now,
    hasPr: true,
  });
  check('a three-week-old question outranks the freshest maxed-out needs_you',
    stale.state === 'blocked' && freshest.state === 'needs_you' && stale.score > freshest.score,
    `${stale.state}/${stale.score} vs ${freshest.state}/${freshest.score}`);

  // The gap is arithmetic, so state it: if someone adds a boost bigger than
  // this, the ordering above breaks silently and this is the check that says so.
  check('  with headroom over every non-user boost combined',
    stale.score - freshest.score > 0 && freshest.score <= 173,
    `needs_you ceiling observed ${freshest.score}`);

  // ...but a human saying "this one" still wins, which is the point of pinning.
  const pinned = score({
    ...base,
    tail: tail({ lastStopReason: 'end_turn' }),
    live: null, lastActivity: now, hasPr: false,
    user: { tags: [], note: '', pinned: true, archived: false } as any,
  });
  check('an explicit pin still outranks a blocked session',
    pinned.score > stale.score, `${pinned.score} vs ${stale.score}`);

  check('the reason names the question rather than the tool',
    stale.reasons[0] === 'asked: which?', JSON.stringify(stale.reasons[0]));
}

const main = async () => {
  console.log(`blocked: ${ROOT}\n`);
  scaffold();
  orderingChecks();

  // Detached so the whole npx wrapper chain is one process group: on Linux
  // neither `npm exec` nor the shell it spawns forwards a signal, so killing
  // the pid we spawned would leave the real server alive for the rest of the
  // suite. See the same note in test-artifacts.ts and test-restore.ts.
  const proc = spawn('npx', ['tsx', 'server/cli.ts'], {
    cwd: REPO,
    env: { ...process.env, HOME: FAKE_HOME, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  try {
    await waitForUp(proc);
    const payload: any = await (await fetch(`${BASE}/api/sessions?force=1`)).json();
    const by = (id: string) => payload.sessions.find((s: any) => s.id === id);
    check('all synthetic sessions are scanned',
      payload.sessions.length === 8, `got ${payload.sessions.length}`);

    // ---- the transcript signal ----
    check('a dead session holding an unanswered question is blocked, not crashed',
      by(S.question)?.state === 'blocked', String(by(S.question)?.state));
    check('  and says what was asked',
      by(S.question)?.reasons?.[0] === 'asked: Which approach should we take here?',
      JSON.stringify(by(S.question)?.reasons));
    check('an unapproved plan is blocked too',
      by(S.plan)?.state === 'blocked', String(by(S.plan)?.state));
    check('  named as a plan, not as a question',
      by(S.plan)?.reasons?.[0] === 'waiting for you to approve a plan',
      JSON.stringify(by(S.plan)?.reasons));
    check('a dangling Bash is still a crash',
      by(S.midBash)?.state === 'crashed', String(by(S.midBash)?.state));
    check('an ANSWERED question is not blocked',
      by(S.answered)?.state !== 'blocked', String(by(S.answered)?.state));

    // ---- the live-registry signal ----
    check('status:waiting is carried through instead of collapsing to idle',
      by(S.permission)?.live?.status === 'waiting', JSON.stringify(by(S.permission)?.live));
    check('  and makes the session blocked',
      by(S.permission)?.state === 'blocked', String(by(S.permission)?.state));
    check('  with the registry label quoted verbatim as the reason',
      by(S.permission)?.reasons?.[0] === 'waiting: permission prompt',
      JSON.stringify(by(S.permission)?.reasons));
    check('an article-less registry label reads correctly',
      by(S.articleless)?.reasons?.[0] === 'waiting: input needed',
      JSON.stringify(by(S.articleless)?.reasons));
    check('status:idle still means needs_you',
      by(S.freshIdle)?.state === 'needs_you', String(by(S.freshIdle)?.state));
    check('a registry entry with no status is not read as idle',
      by(S.noStatus)?.live?.status === 'unknown', JSON.stringify(by(S.noStatus)?.live));
    check('  so a just-launched session does not claim to want you',
      by(S.noStatus)?.state !== 'needs_you' && by(S.noStatus)?.state !== 'blocked',
      String(by(S.noStatus)?.state));

    // ---- ordering, as the UI actually receives it ----
    const attention = payload.sessions.filter(
      (s: any) => s.state === 'blocked' || s.state === 'needs_you' || s.state === 'crashed',
    );
    const blockedCount = attention.filter((s: any) => s.state === 'blocked').length;
    check('every blocked session sorts above the rest of Needs you',
      blockedCount === 4 &&
      attention.slice(0, blockedCount).every((s: any) => s.state === 'blocked'),
      attention.map((s: any) => s.state).join(','));
  } finally {
    try {
      if (proc.pid !== undefined) process.kill(-proc.pid, 'SIGTERM');
    } catch {
      proc.kill('SIGTERM'); // group already gone
    }
    for (const h of holders) h.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail;
};

main()
  .then((f) => { fs.rmSync(ROOT, { recursive: true, force: true }); process.exit(f ? 1 : 0); })
  .catch((e) => { console.error(e); console.error(`left ${ROOT} for inspection`); process.exit(1); });
