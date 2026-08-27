import fs from 'node:fs';
import { getWorkingSet, setWorkingSet } from './store.js';
import { listTerms } from './pty.js';
import type { WorkingSetEntry } from './types.js';

/**
 * Which terminals were open when the app last stopped.
 *
 * Read once at startup and then held in memory, because the persisted set goes
 * on tracking the *live* terminals from here — the moment you open or close
 * one it is rewritten. Without this snapshot the offer would erase itself: the
 * first housekeeping tick after launch records zero live terminals and the
 * thing we meant to restore is gone.
 */
let pending: WorkingSetEntry[] = [];

/**
 * Set on the way down. `shutdownAll()` disposes every terminal, so a capture
 * running after it would faithfully record an empty working set over the one
 * we just saved — turning a clean quit into the one case that loses it.
 */
let frozen = false;

export function initRestore(): void {
  pending = getWorkingSet();
  frozen = false;
}

/** What is still worth offering to reopen. */
export function pendingRestore(): WorkingSetEntry[] {
  return pending;
}

/**
 * Persist the terminals open right now. Safe to call often — the store ignores
 * a set identical to the one it already holds.
 */
export function captureWorkingSet(): void {
  if (frozen) return;
  const seen = new Set<string>();
  const entries: WorkingSetEntry[] = [];
  const add = (e: WorkingSetEntry) => {
    if (seen.has(e.sessionId)) return;
    seen.add(e.sessionId);
    entries.push(e);
  };

  for (const t of listTerms()) {
    // A session started fresh has no transcript until Claude Code writes one,
    // and `claude --resume` needs an id. Nothing to reopen, so nothing to
    // promise: it is left out rather than offered and then failing.
    if (t.exited || !t.sessionId) continue;
    add({ sessionId: t.sessionId, cwd: t.cwd });
  }

  // An offer you have neither taken nor dismissed has to outlive this run too.
  // Without this the first housekeeping tick after launch writes the empty
  // live set straight over it, so launching and quitting without clicking
  // Reopen loses the working set for good — which is the exact thing the
  // feature exists to prevent, and it only shows up on the SECOND relaunch.
  for (const e of pending) add(e);

  setWorkingSet(entries);
}

/**
 * Forget entries that have been settled: reopened (by you or by Reopen all),
 * or gone for good. Keeps a stale offer from lingering in the file, and stops
 * closing a reopened terminal from resurrecting the banner for it.
 */
export function dropPending(sessionIds: string[]): void {
  if (!sessionIds.length) return;
  const gone = new Set(sessionIds);
  const before = pending.length;
  pending = pending.filter((e) => !gone.has(e.sessionId));
  if (pending.length !== before) captureWorkingSet();
}

/** Take the final snapshot and stop tracking. Call before tearing terminals down. */
export function captureAndFreeze(): void {
  captureWorkingSet();
  frozen = true;
}

/** The offer has been taken or waved away; stop making it. */
export function clearRestore(): void {
  pending = [];
  captureWorkingSet();
}

/** A directory that has since been deleted cannot host a terminal. */
export function cwdUsable(cwd: string): boolean {
  try {
    return fs.statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}
