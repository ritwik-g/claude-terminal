import { scanAll, loadCache, saveCache } from './scan.js';
import { readLiveSessions } from './live.js';
import { gitInfoForAll } from './git.js';
import { getUserState, allTags, isReadOnly } from './store.js';
import { score, bucketOf, classifyShape } from './rank.js';
import { listTerms } from './pty.js';
import { pendingRestore, dropPending, cwdUsable } from './restore.js';
import type { RestoreCandidate, Session } from './types.js';

export interface SessionsPayload {
  sessions: Session[];
  tags: string[];
  counts: Record<string, number>;
  scannedAt: number;
  scanMs: number;
  /** state.json is unreadable; tags/priority/pin/snooze cannot be saved. */
  storeReadOnly: boolean;
  /** Terminals open when the app last stopped, still reopenable. */
  restore: RestoreCandidate[];
}

let inflight: Promise<SessionsPayload> | null = null;
let queued: Promise<SessionsPayload> | null = null;
let last: SessionsPayload | null = null;
let lastAt = 0;
const MIN_INTERVAL_MS = 750;

/**
 * Collapses concurrent refreshes and rate-limits them. The UI polls, several
 * tabs may poll at once, and a rescan touches the filesystem — without this,
 * three open windows triple the disk work for identical results.
 */
export async function getSessions(force = false): Promise<SessionsPayload> {
  if (!force && last && Date.now() - lastAt < MIN_INTERVAL_MS) return last;
  // A forced refresh must not be answered by a build that started BEFORE the
  // edit that prompted it — chain a fresh one behind the in-flight scan instead.
  if (inflight) {
    if (!force) return inflight;
    // Coalesce: N forced calls arriving during one build must produce ONE
    // rebuild, not N sequential ones (each does a synchronous whole-index
    // writeFileSync, so holding the refresh key queued a blocking write per
    // keypress).
    if (!queued) {
      queued = inflight.then(() => { queued = null; return build(); });
    }
    return queued;
  }
  inflight = build().finally(() => { inflight = null; });
  return inflight;
}

async function build(): Promise<SessionsPayload> {
  const t0 = Date.now();
  const scanned = await scanAll();
  saveCache();

  const live = readLiveSessions();
  const gits = await gitInfoForAll(scanned.map((s) => s.cwd));
  // A terminal's id is the UI's handle, which equals the session id only when
  // resuming. A session started fresh has id 'new-…' and learns its sessionId
  // later, so keying off t.id alone reported attached:false for every live
  // terminal we started ourselves.
  // Map every id a live terminal answers to -> that terminal's id.
  const termIdFor = new Map<string, string>();
  for (const t of listTerms()) {
    if (t.exited) continue;
    termIdFor.set(t.id, t.id);
    if (t.sessionId) termIdFor.set(t.sessionId, t.id);
  }
  const now = Date.now();

  // How many sessions share each cwd. A directory used by one session (or a
  // worktree) can have its git state attributed to that session; a workspace
  // root shared by a hundred sessions cannot.
  const cwdUsage = new Map<string, number>();
  for (const s of scanned) cwdUsage.set(s.cwd, (cwdUsage.get(s.cwd) ?? 0) + 1);

  const sessions: Session[] = scanned.map((s) => {
    const user = getUserState(s.id);
    const liveInfo = live.get(s.id) ?? null;
    const git = gits.get(s.cwd) ?? null;
    const ownsCwd = (git?.isWorktree ?? false) || (cwdUsage.get(s.cwd) ?? 0) <= 2;
    const { state, score: sc, reasons } = score({
      tail: s.tail,
      live: liveInfo,
      git,
      user,
      lastActivity: s.lastActivity,
      hasPr: !!s.pr,
      ownsCwd,
      now,
    });

    // `_mtimeMs`/`_size` are scan-cache bookkeeping and are not part of Session.
    const { _mtimeMs, _size, ...clean } = s as typeof s & { _mtimeMs?: number; _size?: number };
    void _mtimeMs; void _size;

    return {
      ...clean,
      title: bestTitle(s.title, s.titleSource, liveInfo?.name, s.cwd),
      live: liveInfo,
      git,
      user,
      shape: classifyShape(s.startedAt, s.lastActivity, s.sizeBytes),
      state,
      score: sc,
      reasons,
      attached: termIdFor.has(s.id),
      termId: termIdFor.get(s.id) ?? null,
    };
  });

  // Order must be STABLE between polls or rows shuffle under the pointer and a
  // click lands on the wrong session. Live sessions rewrite their transcript
  // every few seconds, so raw lastActivity is far too twitchy a tiebreak:
  // quantise it to the minute and fall back to id, which never moves.
  sessions.sort(
    (a, b) =>
      b.score - a.score ||
      Math.floor(b.lastActivity / 60_000) - Math.floor(a.lastActivity / 60_000) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const counts: Record<string, number> = {
    attention: 0, working: 0, parked: 0, quiet: 0, snoozed: 0, archived: 0,
  };
  for (const s of sessions) {
    if (s.user.archived) counts.archived++;
    else counts[bucketOf(s, now)]++;
  }

  // Only offer what will actually work — an offer that fails on click is worse
  // than no offer — and settle the rest, so the file does not accumulate
  // entries that can never be shown.
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const restore: RestoreCandidate[] = [];
  const settled: string[] = [];
  for (const entry of pendingRestore()) {
    const s = byId.get(entry.sessionId);
    // Gone for good: the transcript was deleted, or the directory it ran in.
    if (!s || !cwdUsable(s.cwd)) { settled.push(entry.sessionId); continue; }
    // Already dealt with, whether by Reopen all or by you opening it yourself.
    // Dropping it here is what stops closing that terminal later from
    // resurrecting the banner for it.
    if (s.attached) { settled.push(entry.sessionId); continue; }
    // Running in a terminal of your own right now: resuming it a second time
    // would put two clients on one transcript. Still yours, so keep offering
    // it once that terminal goes away.
    if (s.live) continue;
    restore.push({ sessionId: s.id, cwd: s.cwd, title: s.title });
  }
  dropPending(settled);

  const payload: SessionsPayload = {
    sessions,
    tags: allTags(new Set(sessions.map((s) => s.id))),
    counts,
    scannedAt: now,
    scanMs: Date.now() - t0,
    storeReadOnly: isReadOnly(),
    restore,
  };
  last = payload;
  lastAt = Date.now();
  return payload;
}

export function initSessions(): void {
  loadCache();
}

/**
 * A live session's own name usually beats a stale transcript title — but when
 * the user never named it, Claude Code falls back to '<dirname>-<2 hex>'
 * ('unstract-repos-c3'), which is strictly worse than the AI-generated title
 * sitting in the transcript. Prefer the live name only when it is meaningful.
 */
function bestTitle(
  title: string,
  titleSource: string,
  liveName: string | undefined,
  cwd: string,
): string {
  if (!liveName) return title;
  const base = cwd.split('/').filter(Boolean).pop() ?? '';
  const isAutoName = base
    ? new RegExp(`^${escapeRe(base)}-[0-9a-f]{2,4}$`, 'i').test(liveName)
    : false;
  if (isAutoName && titleSource !== 'id') return title;
  return liveName;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
