import { EventEmitter } from 'node:events';
import { readLiveSessions } from './live.js';
import type { CompletionEvent, LiveInfo } from './types.js';

/**
 * Notice when a session stops working, so the app can say so out loud.
 *
 * Deliberately reads ONLY the live registry (live.ts) rather than a full
 * session build. Two reasons, and both matter:
 *
 *  - `getSessions()` is pull-driven — it rebuilds when a client asks. Chromium
 *    throttles timers in a hidden window to roughly one a minute, so a browser
 *    or an unfocused Electron window stops asking at exactly the moment a
 *    notification is worth having. Detection must not ride on the UI's clock.
 *  - A rebuild scans transcripts. This runs on the 2s housekeeping tick, and a
 *    readdir plus a few small JSON parses is cheap enough to do that; reading
 *    every transcript is not.
 *
 * The cost of that choice is that this path cannot tell a clean exit from a
 * crash — that lives in `tail.endedMidTool`, which needs the transcript. So a
 * vanished process is reported as 'exited' and the row itself says which, once
 * the next full build lands a moment later.
 */
export const completionEvents = new EventEmitter();

/**
 * How long a session must STAY stopped before we believe it.
 *
 * Claude Code reports 'idle' the instant a turn ends, and a session that is
 * mid-flow — a hook firing, a queued follow-up, an autonomous loop taking its
 * next step — goes straight back to 'busy'. Firing on the raw edge would
 * notify you about a gap between turns, which is the classic way a feature
 * like this becomes something you switch off.
 *
 * 5s is a starting value, not a measured one: it is long enough to swallow the
 * turn-boundary gaps observed by hand and short enough that a real completion
 * still feels immediate. Tune it against actual use — it is the one number in
 * here that decides whether the feature is useful or irritating.
 */
export const HOLD_MS = 5_000;

/**
 * Recent completions, newest last, for the UI to draw unseen markers from.
 * Bounded because it rides along on every poll payload; the client remembers
 * which ones it has shown you, so this only has to cover the gap between a
 * completion and the next time you look at the window.
 */
const RING = 50;

/** The rest states we are willing to call a completion. */
type Rest = CompletionEvent['kind'];

interface Pending {
  to: Rest;
  /** When it stopped. The hold is measured from here, not from the tick. */
  at: number;
}

/**
 * How long a turn we started ourselves stays unannounced. A keep-warm ping is
 * answered in seconds; a turn still going after this is Claude doing real work
 * — a Stop hook or a loop picked the ping up and carried on — and finishing
 * that IS worth telling you about.
 */
export const QUIET_TURN_MS = 3 * 60_000;

/** Sessions whose next turn the app started itself, id -> deadline. */
let quiet = new Map<string, number>();

/**
 * Do not announce the turn this session is about to take.
 *
 * Keep-warm types a message into an idle session so its prompt cache is read
 * before it expires. That turn is not news — nothing you asked for finished —
 * and announcing it every 45 minutes would put a notification, a dock badge
 * and an unseen dot on every session being kept warm.
 */
export function quietNextTurn(id: string, now = Date.now()): void {
  quiet.set(id, now + QUIET_TURN_MS);
}

/** The turn it was set for is over — whether or not the 2s tick ever saw it running. */
export function clearQuietTurn(id: string): void {
  quiet.delete(id);
}

/** Last status we saw per session. Absent means we have never seen it. */
let seen = new Map<string, LiveInfo['status']>();
/** Stopped, but not yet held long enough to be believed. */
let pending = new Map<string, Pending>();
let ring: CompletionEvent[] = [];

/**
 * Fold one observation of the live registry into the watcher, emitting
 * 'completed' for every session that has now stayed stopped long enough.
 *
 * `now` and `live` are parameters rather than reads so the whole thing can be
 * driven deterministically from a test with no processes and no clock.
 *
 * Note there is no priming step: on the first tick `seen` is empty, so no
 * session has a previous status of 'busy' and nothing can fire. A session
 * already running when the app starts is picked up on that tick and reported
 * normally when it finishes.
 */
export function tickCompletions(now = Date.now(), live = readLiveSessions()): void {
  for (const [id, info] of live) {
    // 'unknown' is a registry entry that has not reported a status yet — a
    // session a second or two old. That is absence of information, not a rest
    // state: recording it would make the next real status look like a
    // transition, and treating it as stopped would announce every launch.
    if (info.status === 'unknown') continue;

    if (info.status === 'busy') {
      // Back to work inside the hold window. This was a gap between turns, not
      // a completion — cancelling it here is the entire point of the hold.
      pending.delete(id);
    } else if (seen.get(id) === 'busy') {
      const deadline = quiet.get(id);
      quiet.delete(id);
      // A turn the app started itself, over quickly: nothing to announce. One
      // that stopped on a dialog is announced regardless — that wants you.
      if (deadline !== undefined && now <= deadline && info.status !== 'waiting') {
        seen.set(id, info.status);
        continue;
      }
      // A background shell left running is still a finished turn; the event
      // vocabulary has no need to tell the two apart.
      pending.set(id, { to: info.status === 'shell' ? 'idle' : info.status, at: now });
    }
    seen.set(id, info.status);
  }

  for (const [id, status] of seen) {
    if (live.has(id)) continue;
    // The process is gone. Only interesting if it was working when it went:
    // a session that was already idle has nothing to announce, and its exit is
    // just you closing a terminal.
    if (status === 'busy') pending.set(id, { to: 'exited', at: now });
    // Forget it either way. If the same id comes back — a resume — it starts
    // with no previous status, so it cannot fire spuriously on arrival.
    seen.delete(id);
  }

  // A ping that never started a turn must not silence the next real one.
  for (const [id, deadline] of quiet) if (now > deadline) quiet.delete(id);

  for (const [id, p] of pending) {
    if (now - p.at < HOLD_MS) continue;
    pending.delete(id);
    const ev: CompletionEvent = { sessionId: id, at: p.at, kind: p.to };
    ring.push(ev);
    if (ring.length > RING) ring.shift();
    completionEvents.emit('completed', ev);
  }
}

/** Recent completions for the poll payload, oldest first. */
export function recentCompletions(): CompletionEvent[] {
  return ring;
}

/** Test seam: drop all accumulated state. */
export function resetCompletions(): void {
  seen = new Map();
  pending = new Map();
  quiet = new Map();
  ring = [];
}
