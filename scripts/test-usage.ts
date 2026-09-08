/**
 * The usage figure survives a round trip through Claude Code:  npm run test:usage
 *
 * The 5-hour window is not in the transcripts this app reads. It lives in
 * Claude Code's own config, which Claude Code only rewrites when `/usage` is
 * rendered — so the app starts a throwaway session, sends `/usage`, and reads
 * the result back. Three things have to hold for that to be safe, and each one
 * broke at least once while it was being written:
 *
 *   - a probe must be skipped inside Claude Code's 5-minute write throttle,
 *     because there the cache never moves and the probe only ever times out
 *   - a cache belonging to another account must read as no cache at all
 *   - a cache older than an hour must be marked, not quietly served as current
 *
 * Self-contained: a throwaway HOME and a stub `claude` on the PATH that writes
 * a usage payload when it is sent `/usage`. Nothing here touches the real
 * ~/.claude.json, and no real session is ever started.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-usage-'));
const FAKE_HOME = path.join(ROOT, 'home');
const STUB = path.join(FAKE_HOME, 'bin', 'claude');
const CONFIG = path.join(FAKE_HOME, '.claude.json');
const PORT = 7796;
const BASE = `http://127.0.0.1:${PORT}`;

const ACCOUNT = 'aaaaaaaa-1111-4111-8111-111111111111';

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
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** The shape Claude Code caches, trimmed to the fields this app reads. */
function config(opts: { fetchedAtMs: number; account?: string; fiveHour: number; weekly: number; pad?: string }): string {
  return JSON.stringify({
    oauthAccount: { accountUuid: ACCOUNT },
    // Only ever grows: the config reader memoises on size and mtime, so two
    // payloads that differ solely in a digit could collide on a coarse clock.
    note: opts.pad ?? '',
    cachedUsageUtilization: {
      fetchedAtMs: opts.fetchedAtMs,
      accountUuid: opts.account ?? ACCOUNT,
      utilization: {
        five_hour: { utilization: opts.fiveHour, resets_at: new Date(opts.fetchedAtMs + 3_600_000).toISOString() },
        seven_day: { utilization: opts.weekly, resets_at: new Date(opts.fetchedAtMs + 86_400_000).toISOString() },
      },
    },
  }, null, 2);
}

function scaffold(): void {
  for (const d of [path.join(FAKE_HOME, 'bin'), path.join(FAKE_HOME, '.claude', 'projects'), path.join(FAKE_HOME, '.claude', 'sessions')]) {
    fs.mkdirSync(d, { recursive: true });
  }

  /**
   * Stands in for Claude Code. It does what the probe actually depends on and
   * nothing else: sit on a PTY, and when sent `/usage`, write a fresh payload
   * into the config. The config path is baked in rather than read from $HOME so
   * the test cannot pass by accidentally writing somewhere else.
   */
  fs.writeFileSync(STUB, [
    '#!/bin/sh',
    "trap 'exit 0' HUP TERM INT",
    'while IFS= read -r line; do',
    '  case "$line" in',
    '    */usage*)',
    `      cat > '${CONFIG}' <<'JSON'`,
    config({ fetchedAtMs: 0, fiveHour: 0, weekly: 0 }).replace(/"fetchedAtMs": 0/, '"fetchedAtMs": __NOW__'),
    'JSON',
    `      sed -i.bak "s/__NOW__/$(date +%s)000/" '${CONFIG}' && rm -f '${CONFIG}.bak'`,
    '      ;;',
    '  esac',
    'done',
    '',
  ].join('\n'));
  fs.chmodSync(STUB, 0o755);
  fs.writeFileSync(path.join(FAKE_HOME, '.zshrc'), `export PATH="${path.dirname(STUB)}:$PATH"\n`);
  fs.writeFileSync(path.join(FAKE_HOME, '.zprofile'), '');
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

const readUsage = async (): Promise<any> => (await fetch(`${BASE}/api/usage`)).json();
const doRefresh = async (): Promise<any> =>
  (await fetch(`${BASE}/api/usage/refresh`, { method: 'POST' })).json();

/** Let the clock move so a rewritten config never lands on the previous mtime. */
const settle = () => new Promise((r) => setTimeout(r, 20));

const main = async () => {
  console.log(`usage: ${ROOT}\n`);
  scaffold();

  const proc = spawn('npx', ['tsx', 'server/cli.ts'], {
    cwd: REPO,
    env: { ...process.env, HOME: FAKE_HOME, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  try {
    await waitForUp(proc);

    check('no config at all reads as no usage, not as zero', (await readUsage()).usage === null);

    // The probe: start a session, send /usage, notice the config move.
    const refreshed = await doRefresh();
    check('a refresh brings back numbers Claude Code wrote',
      refreshed.usage?.fiveHour?.percent === 0 && refreshed.usage?.weekly?.percent === 0,
      JSON.stringify(refreshed.usage));
    check('  and they are not stale', refreshed.usage?.stale === false);
    check('  and the reset time is parsed to a timestamp',
      typeof refreshed.usage?.fiveHour?.resetsAt === 'number',
      JSON.stringify(refreshed.usage?.fiveHour));

    const read = await readUsage();
    check('reading again is the same answer without starting anything',
      read.usage?.fetchedAt === refreshed.usage?.fetchedAt);
    check('  and it reports there is nothing worth refreshing yet', read.refreshable === false);

    // Inside the throttle a probe cannot succeed, so it must not be started:
    // an 8-second spawn that always times out is the failure this prevents.
    const started = Date.now();
    const again = await doRefresh();
    check('a refresh inside the throttle window returns at once',
      Date.now() - started < 2_000, `${Date.now() - started}ms`);
    check('  and leaves the numbers exactly as they were',
      again.usage?.fetchedAt === refreshed.usage?.fetchedAt);

    await settle();
    fs.writeFileSync(CONFIG, config({ fetchedAtMs: Date.now() - 2 * 60 * 60_000, fiveHour: 42, weekly: 7, pad: 'stale' }));
    const old = await readUsage();
    check('an hour-old cache is served, but marked stale',
      old.usage?.fiveHour?.percent === 42 && old.usage?.stale === true,
      JSON.stringify(old.usage));

    await settle();
    fs.writeFileSync(CONFIG, config({ fetchedAtMs: Date.now(), account: 'bbbbbbbb-2222-4222-8222-222222222222', fiveHour: 99, weekly: 99, pad: 'other-account' }));
    const other = await readUsage();
    check('another account\'s cache reads as no usage, never as yours',
      other.usage === null, JSON.stringify(other.usage));
  } finally {
    try {
      if (proc.pid !== undefined) process.kill(-proc.pid, 'SIGTERM');
    } catch {
      proc.kill('SIGTERM'); // group already gone
    }
    await new Promise((r) => setTimeout(r, 600));
    try { execFileSync('pkill', ['-f', STUB], { stdio: 'ignore' }); } catch { /* none left */ }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail;
};

main()
  .then((f) => { fs.rmSync(ROOT, { recursive: true, force: true }); process.exit(f ? 1 : 0); })
  .catch((e) => { console.error(e); console.error(`left ${ROOT} for inspection`); process.exit(1); });
