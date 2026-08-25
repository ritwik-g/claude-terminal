import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { LIVE_DIR } from './paths.js';
import type { LiveInfo } from './types.js';

/**
 * Claude Code writes ~/.claude/sessions/<pid>.json for every running session,
 * carrying a first-party `status` of 'busy' | 'idle'. That is a far better
 * signal than inferring activity from file mtimes, so we prefer it wherever
 * it exists and fall back to transcript tails only for dead sessions.
 */
export function readLiveSessions(): Map<string, LiveInfo> {
  const out = new Map<string, LiveInfo>();
  let entries: string[];
  try {
    entries = fs.readdirSync(LIVE_DIR);
  } catch {
    return out;
  }

  const starts = processStartTimes();

  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(LIVE_DIR, name), 'utf8');
      const d = JSON.parse(raw);
      if (!d?.sessionId || !d?.pid) continue;
      if (!isAlive(d.pid)) continue;
      if (!startMatches(d.pid, d.procStart, starts)) continue;

      out.set(d.sessionId, {
        pid: d.pid,
        status: d.status === 'busy' ? 'busy' : 'idle',
        name: d.name ?? '',
        statusUpdatedAt: d.statusUpdatedAt ?? d.updatedAt ?? 0,
        startedAt: d.startedAt ?? 0,
        socketPath: d.messagingSocketPath,
      });
    } catch {
      // a half-written registry file is normal; skip it
    }
  }
  return out;
}

/** signal 0 tests for existence without touching the process. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM means it exists but belongs to someone else — still alive.
    return err?.code === 'EPERM';
  }
}

/**
 * A SIGKILLed session leaves its registry file behind, and the OS can later
 * recycle that pid — so liveness alone is not proof the entry is real.
 *
 * The right discriminator is `procStart`, which a recycled pid cannot match.
 * An age-based rule is NOT: `statusUpdatedAt` is stamped when a session flips
 * busy<->idle, not on a heartbeat, so it grows stale precisely while a session
 * sits waiting for you. Ageing entries out on it hid the very sessions this
 * tool exists to surface — one real session had been idle 113 hours.
 *
 * Fails OPEN: if we cannot read process start times, we trust the registry.
 * Showing a stale session is a far smaller harm than hiding a live one.
 */
function startMatches(pid: number, procStart: unknown, starts: Map<number, number>): boolean {
  if (typeof procStart !== 'string' || starts.size === 0) return true;
  const actual = starts.get(pid);
  if (actual === undefined) return true;
  // The registry stamps procStart in UTC; `ps lstart` prints local time.
  const claimed = Date.parse(`${procStart} UTC`);
  if (Number.isNaN(claimed)) return true;
  return Math.abs(claimed - actual) < 5000;
}

let startCache: { at: number; map: Map<number, number> } | null = null;
const START_TTL_MS = 15_000;

/** One `ps` for every pid, cached — not one spawn per session. */
function processStartTimes(): Map<number, number> {
  if (startCache && Date.now() - startCache.at < START_TTL_MS) return startCache.map;
  const map = new Map<number, number>();
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,lstart='], {
      encoding: 'utf8',
      timeout: 4000,
      maxBuffer: 8 * 1024 * 1024,
    });
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
      if (!m) continue;
      const t = Date.parse(m[2]);
      if (!Number.isNaN(t)) map.set(Number(m[1]), t);
    }
  } catch {
    // leave the map empty; startMatches then trusts every entry
  }
  startCache = { at: Date.now(), map };
  return map;
}
