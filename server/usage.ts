import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as nodePty from 'node-pty';

import { HOME } from './paths.js';
import { cleanEnv, loginShell } from './pty.js';

/**
 * Claude Code's own config file. It sits BESIDE ~/.claude/, not inside it, so
 * reading it does not touch the transcript tree the rest of this server reads.
 * We only ever read it — the refresh below makes Claude Code write its own
 * config, exactly as it does for every session this app already starts.
 */
const CONFIG_FILE = path.join(HOME, '.claude.json');

/**
 * Both numbers are Claude Code's own, read out of the binary rather than
 * guessed, so our idea of "fresh" is the same as the one the `/usage` panel
 * works to:
 *
 *   REFRESH_THROTTLE_MS  it declines to rewrite the cache more often than this
 *   MAX_AGE_MS           above this age it discards the cache and refetches
 *
 * Mirroring them means we never show a number Claude Code would itself refuse
 * to show, and never spawn a probe whose only effect would be throttled away.
 */
const REFRESH_THROTTLE_MS = 5 * 60 * 1000;
const MAX_AGE_MS = 60 * 60 * 1000;

/** A probe that has not produced a fresh timestamp by now is not going to. */
const PROBE_TIMEOUT_MS = 45_000;
/**
 * Claude Code needs a moment to reach its prompt before a slash command lands,
 * and how long depends on the machine and the project. Rather than parse the
 * screen for a readiness cue — the TUI coupling this design exists to avoid —
 * we send `/usage` on a timer and send it again until the cache moves. A
 * command typed at a prompt that is not ready is dropped, and this session is
 * discarded unread, so a wasted keystroke costs nothing.
 */
const PROBE_SETTLE_MS = 6_000;
const PROBE_RESEND_MS = 6_000;
const POLL_MS = 250;

export interface UsageWindow {
  /** Percent of the window consumed, 0-100, as the API reports it. */
  percent: number;
  /** When the window rolls over, epoch ms. null when the API omits it. */
  resetsAt: number | null;
}

export interface UsageSnapshot {
  /** The account-wide 5-hour rolling window — the one `/usage` calls a session. */
  fiveHour: UsageWindow | null;
  /** The 7-day window. Carried because it is usually the limit that bites. */
  weekly: UsageWindow | null;
  /** When Claude Code last fetched these numbers, epoch ms. */
  fetchedAt: number;
  /** Past MAX_AGE_MS the numbers are history, not status. */
  stale: boolean;
}

interface RawWindow {
  utilization?: unknown;
  resets_at?: unknown;
}

/**
 * Memoised on the file's identity, because both callers are hot: the front end
 * polls the read path, and the probe below checks for a changed timestamp four
 * times a second. Re-parsing 200KB of JSON that often to read two numbers out
 * of it is pure waste. A write that somehow lands on the same mtime and size
 * costs one poll's delay, which neither caller can notice.
 */
let parsedConfig: { key: string; value: any } | null = null;

function readConfig(): any | null {
  try {
    const st = fs.statSync(CONFIG_FILE);
    const key = `${st.mtimeMs}:${st.size}`;
    if (parsedConfig?.key === key) return parsedConfig.value;
    const value = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    parsedConfig = { key, value };
    return value;
  } catch {
    // Missing, unreadable, or half-written while Claude Code saves it. All
    // three mean "no number to show", which the caller renders as nothing.
    // Deliberately not cached, so the next call retries.
    return null;
  }
}

function parseWindow(raw: RawWindow | null | undefined): UsageWindow | null {
  if (!raw || typeof raw.utilization !== 'number') return null;
  const at = typeof raw.resets_at === 'string' ? Date.parse(raw.resets_at) : NaN;
  return {
    percent: Math.max(0, Math.min(100, Math.round(raw.utilization))),
    resetsAt: Number.isFinite(at) ? at : null,
  };
}

/**
 * The 5-hour window is account-wide server state, not something that can be
 * derived from the transcripts this app reads: those carry per-session token
 * counts, and the window is a weighted, account-level figure shared across
 * every session and every machine you are signed in on. Claude Code caches the
 * server's answer here, so reading its cache is the only honest local source.
 *
 * Returns null when there is no usable cache at all — including when it belongs
 * to a different account, which happens after switching logins and which Claude
 * Code itself treats as no cache rather than as someone else's numbers.
 */
export function readUsage(): UsageSnapshot | null {
  const cfg = readConfig();
  const cached = cfg?.cachedUsageUtilization;
  if (!cached || typeof cached.fetchedAtMs !== 'number') return null;

  const account = cfg?.oauthAccount?.accountUuid;
  if (account && cached.accountUuid && cached.accountUuid !== account) return null;

  const u = cached.utilization ?? {};
  const fiveHour = parseWindow(u.five_hour);
  const weekly = parseWindow(u.seven_day);
  if (!fiveHour && !weekly) return null;

  return {
    fiveHour,
    weekly,
    fetchedAt: cached.fetchedAtMs,
    stale: Date.now() - cached.fetchedAtMs > MAX_AGE_MS,
  };
}

function fetchedAtOf(cfg: any): number | null {
  const at = cfg?.cachedUsageUtilization?.fetchedAtMs;
  return typeof at === 'number' ? at : null;
}

/**
 * Where the probe runs: one empty directory of our own, in the temp dir.
 *
 * It must not be a directory the user actually works in. Starting Claude Code
 * somewhere records that visit against the project — `lastSessionId`, `lastCost`
 * and friends — so probing inside a real repo would repoint that repo's
 * `claude --continue` at a throwaway session and zero its recorded stats
 * (measured). A directory of our own absorbs all of that instead.
 *
 * The path is fixed rather than freshly minted per probe, because Claude Code
 * adds an entry to its projects map for wherever it starts: a new path each
 * time would grow that map forever, where a fixed one is a single entry reused.
 *
 * Deliberately NOT under ~/.claude-terminal/: CLAUDE.md is discovered up the
 * directory tree, so a probe rooted under $HOME inherits the user's personal
 * CLAUDE.md and, if it uses @-includes, can raise the external-includes
 * approval dialog — a modal, on startup, in the one place we cannot answer one.
 * The temp directory has no such ancestor.
 */
function probeDir(): string {
  const dir = path.join(os.tmpdir(), 'claude-terminal-usage-probe');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let inFlight: Promise<UsageSnapshot | null> | null = null;

/**
 * Refresh the cache by making Claude Code fetch its own usage.
 *
 * Nothing on disk carries the 5-hour window until Claude Code asks the server
 * for it, and it only asks when the `/usage` panel is rendered — a headless
 * `claude -p` run leaves the cache untouched (measured). So the only way to a
 * current number is to run `/usage` somewhere, and the only place to run it
 * that does not disturb the user is a terminal of our own.
 *
 * We never read the rendered panel. Scraping a TUI means reconstructing text
 * that is positioned with cursor escapes rather than spaces, and the parser
 * would break on any redesign. Instead we watch `fetchedAtMs` in the config
 * file: the fetch we triggered is the thing that moves it, and the payload it
 * writes is already structured. The screen is never the source.
 *
 * Fails soft in every case — a timeout, a missing binary, an unexpected prompt
 * — by returning whatever the cache already held. A stale number labelled stale
 * is useful; a wrong one is not.
 */
export function refreshUsage(): Promise<UsageSnapshot | null> {
  // One probe at a time. Concurrent callers get the running one's answer, so a
  // click during the periodic refresh cannot start a second `claude`.
  if (inFlight) return inFlight;

  // Inside the throttle window Claude Code fetches its usage but declines to
  // rewrite the cache, so `fetchedAtMs` never moves and the probe cannot tell
  // success from failure — it just times out. Skipping is not an optimisation:
  // it is the only window in which the probe means anything.
  const cached = readUsage();
  if (!needsRefresh(cached)) return Promise.resolve(cached);

  inFlight = runProbe().finally(() => { inFlight = null; });
  return inFlight;
}

/** True when a refresh would do anything Claude Code would not throttle away. */
export function needsRefresh(snapshot: UsageSnapshot | null): boolean {
  if (!snapshot) return true;
  return Date.now() - snapshot.fetchedAt >= REFRESH_THROTTLE_MS;
}

export function refreshInFlight(): boolean {
  return inFlight !== null;
}

async function runProbe(): Promise<UsageSnapshot | null> {
  const cfg = readConfig();
  const before = fetchedAtOf(cfg);

  let cwd: string;
  try {
    cwd = probeDir();
  } catch (err) {
    console.error('[claude-terminal] usage probe has nowhere to run:', err);
    return readUsage();
  }

  const env = cleanEnv();
  /**
   * This is not a session and must never look like one. The marker turns
   * Claude Code's transcript writing off, so the probe cannot leave a JSONL
   * behind for scan.ts to find and rank alongside the user's real work.
   */
  env.CLAUDE_CODE_CHILD_SESSION = '1';
  /**
   * Claude Code asks "do you trust the files in this folder?" the first time it
   * starts anywhere new, and a probe that meets a dialog just hangs until it
   * times out. This marker is the one lever that answers it without writing to
   * Claude Code's config: it is read in exactly the trust and permission-gating
   * checks and nowhere else. Setting it is honest here — the folder is empty and
   * ours, so the question it suppresses has no files to be asked about — and it
   * grants the probe nothing, because the probe never submits a prompt and so
   * never runs a tool.
   */
  env.CLAUDE_CODE_SANDBOXED = '1';

  let proc: nodePty.IPty;
  try {
    proc = nodePty.spawn(loginShell(), ['-l', '-c', 'exec claude'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd,
      env,
    });
  } catch (err) {
    console.error('[claude-terminal] usage probe could not start:', err);
    return readUsage();
  }

  // Read and discard. The data is never parsed, but an unread PTY fills its
  // buffer and stalls the child before it can make the request.
  proc.onData(() => {});

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    // Escape first so Claude Code leaves the panel and shuts down the way it
    // would if you closed it yourself; SIGHUP — the same signal the terminals
    // this app owns are closed with — in case it does not.
    try { proc.write('\x1b'); } catch { /* already gone */ }
    try { proc.kill('SIGHUP'); } catch { /* already gone */ }
  };

  try {
    return await new Promise<UsageSnapshot | null>((resolve) => {
      const started = Date.now();
      let sent = false;
      let lastSent = -PROBE_RESEND_MS;

      const tick = setInterval(() => {
        const elapsed = Date.now() - started;

        if (elapsed >= PROBE_SETTLE_MS && elapsed - lastSent >= PROBE_RESEND_MS) {
          lastSent = elapsed;
          sent = true;
          try {
            proc.write('/usage\r');
          } catch {
            clearInterval(tick);
            finish();
            resolve(readUsage());
            return;
          }
        }

        if (sent && fetchedAtOf(readConfig()) !== before) {
          clearInterval(tick);
          finish();
          resolve(readUsage());
          return;
        }

        if (elapsed >= PROBE_TIMEOUT_MS) {
          clearInterval(tick);
          finish();
          // Most likely an unexpected prompt we deliberately did not answer.
          console.error('[claude-terminal] usage probe timed out; keeping cached numbers');
          resolve(readUsage());
        }
      }, POLL_MS);

      proc.onExit(() => {
        if (done) return;
        clearInterval(tick);
        done = true;
        resolve(readUsage());
      });
    });
  } finally {
    finish();
  }
}
