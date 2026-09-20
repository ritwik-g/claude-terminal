/**
 * Which name a row shows:  npm run test:title
 *
 * Self-contained — builds a throwaway HOME with synthetic transcripts and a
 * synthetic live registry, then runs a server against it.
 *
 * A live session carries a `name` of its own, and it usually beats the
 * transcript title: it is what you renamed the session to, and it updates the
 * instant you do. But when you never named it, Claude Code invents one —
 * '<dirname>-<2-4 hex>' — and that is strictly worse than the ai-title the
 * transcript already has, so the invented ones have to be recognised and
 * ignored.
 *
 * The trap is that the invented name is minted ONCE, from the directory the
 * session STARTED in, while `cwd` follows the session as it moves. Matching
 * the two stopped working the moment a session cd'd into a subdirectory or a
 * worktree — an entirely ordinary thing to do — and the row then renamed
 * itself, mid-run, to the folder it had been launched from.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-title-'));
const FAKE_HOME = path.join(ROOT, 'home');
const WORK = path.join(ROOT, 'work');
const PORT = 7797;
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
  moved: '11111111-1111-4111-8111-bbbbbbbbbbbb',
  stayed: '22222222-2222-4222-8222-bbbbbbbbbbbb',
  renamed: '33333333-3333-4333-8333-bbbbbbbbbbbb',
  untitled: '44444444-4444-4444-8444-bbbbbbbbbbbb',
  hexish: '55555555-5555-4555-8555-bbbbbbbbbbbb',
  dead: '66666666-6666-4666-8666-bbbbbbbbbbbb',
};

/**
 * Two project directories, because a project key is the only record of where
 * a session STARTED and the two anchors have to be tested apart:
 *
 *   started-here   its key ends with the start folder's name, dash and all,
 *                  which is what catches a session that has since moved.
 *   started-away   its key names some other folder entirely, so only the
 *                  current cwd can vouch for a name here.
 */
const P_HERE = path.join(FAKE_HOME, '.claude', 'projects', '-ct-title-my-repo');
const P_AWAY = path.join(FAKE_HOME, '.claude', 'projects', '-ct-title-elsewhere');
const LIVE = path.join(FAKE_HOME, '.claude', 'sessions');

/** Where the sessions actually are now, as opposed to where they began. */
const REPO_DIR = path.join(WORK, 'my-repo');
const WT_DIR = path.join(REPO_DIR, '_wt', 'feature-branch');

const now = Date.now();
const at = (offMs: number) => new Date(now - offMs).toISOString();

function write(dir: string, id: string, lines: unknown[]): void {
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

/** A transcript whose ai-title is the good name the row ought to keep. */
const titled = (cwd: string, title: string) => [
  { type: 'ai-title', aiTitle: title, cwd, timestamp: at(900_000) },
  { type: 'user', message: { role: 'user', content: 'do the thing' }, cwd, timestamp: at(880_000) },
  {
    type: 'assistant',
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
    cwd,
    timestamp: at(60_000),
  },
];

function scaffold(): void {
  for (const d of [P_HERE, P_AWAY, LIVE, WT_DIR]) fs.mkdirSync(d, { recursive: true });

  // Started in my-repo, now in a worktree under it. This is the reported bug.
  write(P_HERE, S.moved, titled(WT_DIR, 'Staging database CPU bottleneck investigation'));

  // Never moved, and its project key names a different folder — so the only
  // thing that can recognise its invented name is the cwd it is sitting in.
  write(P_AWAY, S.stayed, titled(REPO_DIR, 'A Title Worth Keeping'));

  // Renamed by hand. The name is the whole point and must win.
  write(P_HERE, S.renamed, titled(WT_DIR, 'Staging database CPU bottleneck investigation'));

  // Nothing in the transcript to fall back TO: no title record, and not a
  // word typed by a person, so scan.ts is down to the session id. An invented
  // name beats eight hex digits.
  write(P_HERE, S.untitled, [
    {
      type: 'assistant',
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
      cwd: WT_DIR,
      timestamp: at(60_000),
    },
  ]);

  // A name a person chose that happens to end in something hex-shaped. It
  // matches no directory this session has ever been in, so it is a real name.
  write(P_HERE, S.hexish, titled(WT_DIR, 'An Ai Title'));

  // No registry entry at all: the transcript is the only source there is.
  write(P_HERE, S.dead, titled(WT_DIR, 'Long Since Finished'));

  /**
   * Registry entries for a process that is genuinely alive — our own. `pid` is
   * all that liveness checks, and omitting `procStart` takes the documented
   * fail-open path, so this exercises the real readLiveSessions.
   */
  const reg = (sessionId: string, name: string, cwd: string) => {
    const pid = spawnHolder();
    fs.writeFileSync(path.join(LIVE, `${pid}.json`), JSON.stringify({
      pid, sessionId, cwd, name, status: 'idle', kind: 'interactive',
      startedAt: now - 900_000, updatedAt: now, statusUpdatedAt: now,
    }));
  };

  reg(S.moved, 'my-repo-6e', WT_DIR);
  reg(S.stayed, 'my-repo-ab', REPO_DIR);
  reg(S.renamed, 'staging-db-investigation', WT_DIR);
  reg(S.untitled, 'my-repo-c3', WT_DIR);
  reg(S.hexish, 'ship-it-beef', WT_DIR);
}

/**
 * A registry entry is only honoured if its pid is genuinely alive, so the
 * fixtures need real processes to point at.
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

const main = async () => {
  console.log(`title: ${ROOT}\n`);
  scaffold();

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
    const titleOf = (id: string) => by(id)?.title;

    check('all synthetic sessions are scanned', payload.sessions.length === 6, `got ${payload.sessions.length}`);
    check('the live registry was read at all',
      payload.sessions.filter((s: any) => s.live).length === 5,
      String(payload.sessions.filter((s: any) => s.live).length));

    // The bug: an invented name outliving the directory it was invented in.
    check('a session that moved keeps its ai-title',
      titleOf(S.moved) === 'Staging database CPU bottleneck investigation', titleOf(S.moved));
    check('  rather than renaming itself to the folder it started in',
      titleOf(S.moved) !== 'my-repo-6e', titleOf(S.moved));

    check('a session that never moved keeps its ai-title too',
      titleOf(S.stayed) === 'A Title Worth Keeping', titleOf(S.stayed));

    check('a name you chose wins over the transcript',
      titleOf(S.renamed) === 'staging-db-investigation', titleOf(S.renamed));

    check('an invented name still beats having no title at all',
      titleOf(S.untitled) === 'my-repo-c3', titleOf(S.untitled));

    check('a real name that merely ends in hex is not mistaken for an invented one',
      titleOf(S.hexish) === 'ship-it-beef', titleOf(S.hexish));

    check('a session with no registry entry falls back to the transcript',
      titleOf(S.dead) === 'Long Since Finished', titleOf(S.dead));
  } finally {
    try {
      if (proc.pid !== undefined) process.kill(-proc.pid, 'SIGTERM');
    } catch {
      proc.kill('SIGTERM'); // group already gone
    }
    for (const h of holders) h.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail;
};

main()
  .then((f) => { fs.rmSync(ROOT, { recursive: true, force: true }); process.exit(f ? 1 : 0); })
  .catch((e) => { console.error(e); console.error(`left ${ROOT} for inspection`); process.exit(1); });
