import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { listTerms, writeTerm, type TermInfo } from './pty.js';
import { readLiveStatusByPid } from './live.js';
import { readUsage } from './usage.js';
import { quietNextTurn, clearQuietTurn } from './completions.js';
import { KEEPWARM_MARKER, type KeepWarmHold, type KeepWarmStop, type KeepWarmView, type LiveInfo } from './types.js';

/**
 * Keep a session's prompt cache from expiring while you are away from it.
 *
 * Claude Code's main-thread prompt cache lives for an hour from the last API
 * call that read it. Come back after that and the whole conversation is
 * written into the cache again, at roughly twice the input price, on your
 * first turn. A cache READ costs about a tenth of the input price and resets
 * the hour — so a tiny turn sent before the hour is up keeps the cache alive
 * for a small fraction of what rebuilding it costs. About twenty pings cost
 * what one cold resume does, which makes this right for "back after lunch"
 * and marginal for "back tomorrow": a full day is about thirty pings, worth it
 * only for a big context you would rather not have rebuilt. Hence durations,
 * a day at most, and no open-ended mode.
 *
 * The ping is an ordinary message typed at the prompt of a terminal this app
 * owns, exactly as you would type it. That is the only way in — and it means
 * the message goes wherever the cursor is. So the rules below are all about
 * NOT typing when doing so could land somewhere it should not:
 *
 *  - Only when the registry says the prompt is free: 'idle', or 'shell' (idle
 *    with a background shell running). Anything else holds the ping — busy,
 *    waiting on a dialog, no status yet. A stuck 'busy' therefore costs a
 *    missed ping, never a wrong one; Ping anyway is the human override.
 *  - Never over an unanswered question or plan, whatever the registry says.
 *  - Never over something you typed and did not send. Every keystroke you
 *    type in our terminals passes through this server, so we know when you
 *    last typed; if that is after the last message you sent, the input box may
 *    hold a draft, and the ping would be appended to it and submitted. In that
 *    case keep-warm turns itself OFF and says why, rather than guessing whether
 *    you cleared it. Turning it back on is you saying the box is empty.
 *
 * The ping's own turn is kept out of everything else the app reports: it is
 * not a completion (completions.ts), not activity, not your last prompt, and
 * not searchable text (scan.ts, by KEEPWARM_MARKER).
 */

/** Ping this long after the last API call: a quarter of the hour in hand. */
export const PING_AFTER_MS = 45 * 60_000;
/** The main-thread cache lifetime the whole feature is built around. */
export const CACHE_TTL_MS = 60 * 60_000;
/**
 * Consecutive misses on pings that SHOULD have hit before giving up. One can
 * be bad luck; two means the cache is not living as long as this assumes —
 * the 5-minute tier, a model switch, an overage — and more pings are waste.
 */
export const MISSES_TO_STOP = 2;
/** The longest keep-warm will run, whatever was asked for. */
export const MAX_MINUTES = 24 * 60;
export const MIN_MINUTES = 30;
/** A ping with no reply by now did not start a turn. */
const REPLY_WAIT_MS = 5 * 60_000;
/**
 * Enter goes separately from the text. A burst of characters with a carriage
 * return at the end risks being read as a paste, where the return is a newline
 * rather than a submit.
 */
const SUBMIT_DELAY_MS = 150;

export { KEEPWARM_MARKER };
export const PING_TEXT =
  `${KEEPWARM_MARKER} Automated cache refresh from Claude Terminal. ` +
  'Nothing to do: reply with only "ok" and use no tools.';

/** Stops worth interrupting you about. The others are keep-warm doing what you asked. */
export const WARN_STOPS: ReadonlySet<KeepWarmStop> = new Set(['typed', 'cache-miss', 'terminal-closed', 'no-reply']);

export interface KeepWarmOptions {
  minutes: number;
  untilSend: boolean;
  pausePct: number | null;
}

interface Entry {
  sessionId: string;
  file: string;
  opts: KeepWarmOptions;
  enabledAt: number;
  until: number;
  /** Keystrokes before this do not count as unsent typing — see enable. */
  clearSince: number;
  pings: number;
  lastPingAt: number | null;
  /**
   * A ping is out and its reply has not been read yet. `measured` is false for
   * a Ping anyway into a session that was not at rest: that text is queued into
   * a running turn, so the next API call belongs to that turn, and reading the
   * cache off it would score the wrong call.
   */
  awaiting: { sentAt: number; expectWarm: boolean; measured: boolean } | null;
  lastResult: KeepWarmView['lastResult'];
  misses: number;
  held: KeepWarmHold | null;
  heldSince: number | null;
  stopped: { reason: KeepWarmStop; at: number } | null;
}

export interface KeepWarmStoppedEvent {
  sessionId: string;
  reason: KeepWarmStop;
  at: number;
}

export const keepWarmEvents = new EventEmitter();

const entries = new Map<string, Entry>();
/** termId -> when you last typed in it (terminal reports excluded). */
const typedAt = new Map<string, number>();

/**
 * Everything that touches the outside world, so a test can drive the whole
 * engine with a fake clock, fake terminals and fake statuses.
 */
export interface KeepWarmDeps {
  terms: () => TermInfo[];
  status: (pid: number) => LiveInfo['status'] | null;
  fiveHourPct: (now: number) => number | null;
  write: (termId: string, data: string) => boolean;
  later: (fn: () => void, ms: number) => void;
}

const realDeps: KeepWarmDeps = {
  terms: listTerms,
  status: readLiveStatusByPid,
  fiveHourPct: (now) => {
    const w = readUsage()?.fiveHour;
    // A reading from a window that has since rolled over says nothing about
    // the window we are in.
    if (!w || (w.resetsAt !== null && w.resetsAt <= now)) return null;
    return w.percent;
  },
  write: writeTerm,
  later: (fn, ms) => { setTimeout(fn, ms).unref?.(); },
};
let deps: KeepWarmDeps = realDeps;

/** Test seam. */
export function setKeepWarmDeps(over: Partial<KeepWarmDeps> | null): void {
  deps = over ? { ...realDeps, ...over } : realDeps;
}

/** Test seam: drop all state. */
export function resetKeepWarm(): void {
  entries.clear();
  typedAt.clear();
  turnCache.clear();
}

// ----------------------------------------------------------------- typing

/**
 * Sequences a terminal sends by itself, in reply to a query or an event, that
 * reach the server down the same socket as your keys. xterm.js answers device
 * queries, reports focus when Claude Code asks for it, and reports the mouse
 * in mouse mode — so clicking into the pane or scrolling it would otherwise
 * read as typing and turn keep-warm off for nothing. None of these put text in
 * the input box. Anything NOT matched counts as typing, which is the safe way
 * round: an unrecognised sequence costs a false alarm, never a lost draft.
 */
const TERMINAL_REPORTS = new RegExp([
  '\\x1b\\[[IO]',                               // focus in / out
  '\\x1b\\[<\\d+;\\d+;\\d+[Mm]',                // SGR mouse
  '\\x1b\\[M[\\s\\S]{3}',                       // X10 mouse
  '\\x1b\\[[?>=][\\d;]*c',                      // device attributes
  '\\x1b\\[\\d+;\\d+R',                         // cursor position report
  '\\x1b\\[\\??[\\d;]*\\$y',                    // mode report
  '\\x1b\\[\\?\\d*u',                           // kitty keyboard flags
  '\\x1b\\[\\d+(?:;\\d+)*t',                    // window reports
  '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)',  // OSC replies (colours)
  '\\x1bP[\\s\\S]*?\\x1b\\\\',                  // DCS replies (version, DECRQSS)
].join('|'), 'g');

export function isTyping(data: string): boolean {
  return data.replace(TERMINAL_REPORTS, '').length > 0;
}

/**
 * Called with every chunk of input the socket carries for a terminal.
 *
 * Only watched while keep-warm is on for the session in it: turning keep-warm
 * on starts the clock afresh, so anything typed before that cannot matter.
 *
 * Keys that answer a dialog go to the dialog, not the input box, so they are
 * not a draft — answering a permission prompt must not turn keep-warm off. The
 * status is read per keystroke, from the process's own registry file.
 *
 * Only keys shaped like a dialog answer are let off, though, not everything
 * pressed while the registry says 'waiting'. The file can lag the screen by a
 * moment after a dialog closes, and a paste or the first letters of a draft
 * typed in that gap would otherwise go unrecorded — the one way a ping could
 * land on top of real text. A letter typed into a dialog's own feedback field
 * then counts as typing too: a false alarm, which is the safe way round.
 */
const DIALOG_KEY = /^(?:\r|[0-9yYnN ]|\t|\x1b|\x1b\[Z|\x1b(?:\[|O)[ABCD])$/;

export function noteInput(termId: string, data: string, now = Date.now()): void {
  if (!isTyping(data)) return;
  const term = deps.terms().find((t) => t.id === termId);
  if (!term?.sessionId) return;
  const e = entries.get(term.sessionId);
  if (!e || e.stopped) return;
  if (DIALOG_KEY.test(data) && deps.status(term.pid) === 'waiting') return;
  typedAt.set(termId, now);
}

// ------------------------------------------------------------- transcript

interface TurnInfo {
  /** Last main-thread assistant record: the last API call, which the cache hour runs from. */
  lastApiAt: number | null;
  /** Last message you sent. Keep-warm's own pings are not yours. */
  lastSentAt: number | null;
  /** The transcript ends on an unanswered AskUserQuestion or ExitPlanMode. */
  pendingQuestion: boolean;
  /** Recent main-thread API calls and what they read from the cache, oldest first. */
  calls: { at: number; read: number; write: number }[];
}

const TAIL_BYTES = 1024 * 1024;
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const turnCache = new Map<string, { mtimeMs: number; size: number; info: TurnInfo }>();

/** Only the transcript's tail matters, and only when it has changed. */
export function readTurns(file: string): TurnInfo | null {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = turnCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.info;

  let text: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(st.size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      text = buf.toString('utf8');
      // A mid-file read starts mid-line; drop the fragment.
      if (len < st.size) text = text.slice(text.indexOf('\n') + 1);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  const info = parseTurns(text);
  turnCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, info });
  return info;
}

export function parseTurns(text: string): TurnInfo {
  const info: TurnInfo = { lastApiAt: null, lastSentAt: null, pendingQuestion: false, calls: [] };
  /** Question tool calls not yet answered, by tool_use id. */
  let openQuestions = new Set<string>();

  for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.isSidechain === true) continue;
    const at = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
    if (Number.isNaN(at)) continue;

    if (rec.type === 'assistant') {
      info.lastApiAt = at;
      const u = rec.message?.usage;
      if (u && typeof u === 'object') {
        const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
        info.calls.push({ at, read: n(u.cache_read_input_tokens), write: n(u.cache_creation_input_tokens) });
        if (info.calls.length > 50) info.calls.shift();
      }
      const content = Array.isArray(rec.message?.content) ? rec.message.content : [];
      for (const part of content) {
        if (part?.type === 'tool_use' && QUESTION_TOOLS.has(part.name) && part.id) openQuestions.add(part.id);
      }
    } else if (rec.type === 'user') {
      const content = rec.message?.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part?.type === 'tool_result' && part.tool_use_id) openQuestions.delete(part.tool_use_id);
        }
      }
      if (isSentByYou(rec)) {
        info.lastSentAt = at;
        // Anything you send settles whatever was being asked.
        openQuestions = new Set();
      }
    }
  }
  info.pendingQuestion = openQuestions.size > 0;
  return info;
}

/**
 * A message you sent, as opposed to a tool result, a background task's
 * notification, injected context, or one of our own pings.
 *
 * Current Claude Code says so outright (`origin.kind`, `promptSource`). Older
 * transcripts carry neither, and for those anything with real text that is not
 * meta and not a tool result counts — including a slash command, which is you
 * pressing Enter just the same.
 */
function isSentByYou(rec: any): boolean {
  if (rec.isMeta) return false;
  const content = rec.message?.content;
  const text = textOf(content);
  if (text.startsWith(KEEPWARM_MARKER)) return false;
  const kind = rec.origin?.kind;
  if (kind !== undefined) return kind === 'human';
  if (rec.promptSource !== undefined) return rec.promptSource === 'typed';
  if (Array.isArray(content) && content.some((p: any) => p?.type === 'tool_result')) return false;
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .trim().length > 0;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content.trimStart();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const p of content) if (p?.type === 'text' && typeof p.text === 'string') parts.push(p.text);
  return parts.join(' ').trimStart();
}

// ----------------------------------------------------------------- engine

function termFor(sessionId: string): TermInfo | null {
  return deps.terms().find((t) => !t.exited && t.sessionId === sessionId) ?? null;
}

function stop(e: Entry, reason: KeepWarmStop, now: number): void {
  if (e.stopped) return;
  e.stopped = { reason, at: now };
  e.awaiting = null;
  e.held = null;
  e.heldSince = null;
  keepWarmEvents.emit('stopped', { sessionId: e.sessionId, reason, at: now } satisfies KeepWarmStoppedEvent);
}

function hold(e: Entry, why: KeepWarmHold, now: number): void {
  if (e.held !== why) e.heldSince = now;
  e.held = why;
}

function unhold(e: Entry): void {
  e.held = null;
  e.heldSince = null;
}

/** You typed after the last message you sent, so the box may hold a draft. */
function unsentTypingSince(e: Entry, termId: string, turns: TurnInfo): number | null {
  const typed = typedAt.get(termId);
  if (typed === undefined) return null;
  return typed > Math.max(turns.lastSentAt ?? 0, e.clearSince) ? typed : null;
}

type Blocker = 'waiting' | 'question' | 'typed';

/**
 * The checks no ping may skip, manual or not: never into a dialog, never over
 * an unanswered question, never on top of something you typed.
 */
function hardBlocker(e: Entry, term: TermInfo, turns: TurnInfo): Blocker | null {
  if (deps.status(term.pid) === 'waiting') return 'waiting';
  if (turns.pendingQuestion) return 'question';
  if (unsentTypingSince(e, term.id, turns) !== null) return 'typed';
  return null;
}

const atRest = (s: LiveInfo['status'] | null) => s === 'idle' || s === 'shell';

function send(e: Entry, term: TermInfo, turns: TurnInfo, now: number): void {
  const measured = atRest(deps.status(term.pid));
  // Announcing this turn as a completion would put a notification and an
  // unseen dot on the session every 45 minutes. Only when the session is at
  // rest, though: pinging a busy one (Ping anyway), the next finish is the
  // turn that was already running, and that one IS news.
  if (measured) quietNextTurn(e.sessionId, now);
  if (!deps.write(term.id, PING_TEXT)) { stop(e, 'terminal-closed', now); return; }
  // Whether a miss is news depends on whether the cache should still have been
  // there. A ping sent after the hour was already up is rebuilding it — which
  // is what turning keep-warm on for a session left too long costs.
  const sinceCall = turns.lastApiAt === null ? Infinity : now - turns.lastApiAt;
  e.awaiting = { sentAt: now, expectWarm: sinceCall < CACHE_TTL_MS - 60_000, measured };
  e.pings += 1;
  e.lastPingAt = now;
  unhold(e);
  deps.later(() => {
    if (e.stopped || e.awaiting?.sentAt !== now) return;
    // Look again before pressing Enter: keys you typed in the last moment are
    // behind the ping in the box now, and Enter would submit them with it.
    if ((typedAt.get(term.id) ?? 0) >= now) { stop(e, 'typed', Date.now()); return; }
    // A turn that started meanwhile — a background task reporting in — would
    // take the Enter as input to itself. Leave the text and say so.
    if (measured && !atRest(deps.status(term.pid))) { stop(e, 'no-reply', Date.now()); return; }
    deps.write(term.id, '\r');
  }, SUBMIT_DELAY_MS);
}

/** Read the reply to the ping that is out, once it has landed and the turn is over. */
function settleReply(e: Entry, term: TermInfo, turns: TurnInfo, now: number): void {
  if (!e.awaiting) return;
  const reply = turns.calls.find((c) => c.at >= e.awaiting!.sentAt);
  if (!reply) {
    // No turn came of it. The text may be sitting unsent in the input box, and
    // pinging again would pile a second copy on top — so stop and say so.
    if (now - e.awaiting.sentAt > REPLY_WAIT_MS) stop(e, 'no-reply', now);
    return;
  }
  // Wait for the turn to end. Settling while it runs would drop the quiet
  // flag below before completions.ts has seen the turn finish — and it would
  // then announce the ping.
  if (!atRest(deps.status(term.pid))) return;
  // A reply too quick for the 2s tick to see as busy leaves the flag unused;
  // left set, it would swallow your next real finish.
  clearQuietTurn(e.sessionId);
  if (!e.awaiting.measured) { e.awaiting = null; return; }
  const hit = reply.read >= reply.write;
  if (hit) {
    e.lastResult = 'hit';
    e.misses = 0;
  } else if (!e.awaiting.expectWarm) {
    e.lastResult = 'cold';
  } else {
    e.lastResult = 'miss';
    e.misses += 1;
  }
  e.awaiting = null;
  if (e.misses >= MISSES_TO_STOP) stop(e, 'cache-miss', now);
}

/** One pass over every session being kept warm. Runs on the server's clock. */
export function tickKeepWarm(now = Date.now()): void {
  for (const e of entries.values()) {
    if (e.stopped) continue;

    const term = termFor(e.sessionId);
    if (!term) {
      stop(e, 'terminal-closed', now);
      for (const id of [...typedAt.keys()]) if (!deps.terms().some((t) => t.id === id && !t.exited)) typedAt.delete(id);
      continue;
    }
    if (now >= e.until) { stop(e, 'expired', now); continue; }

    const turns = readTurns(e.file);
    if (!turns || turns.lastApiAt === null) { hold(e, 'no-turn', now); continue; }

    settleReply(e, term, turns, now);
    if (e.stopped) continue;

    if (e.opts.untilSend && (turns.lastSentAt ?? 0) > e.enabledAt) { stop(e, 'sent', now); continue; }

    if (now < turns.lastApiAt + PING_AFTER_MS) { unhold(e); continue; }
    if (e.awaiting) continue;

    const blocker = hardBlocker(e, term, turns);
    if (blocker === 'typed') { stop(e, 'typed', now); continue; }
    if (blocker) { hold(e, blocker, now); continue; }

    const status = deps.status(term.pid);
    if (status !== 'idle' && status !== 'shell') {
      hold(e, status === null ? 'no-status' : status === 'busy' ? 'busy' : 'unknown', now);
      continue;
    }

    const pct = e.opts.pausePct === null ? null : deps.fiveHourPct(now);
    if (pct !== null && e.opts.pausePct !== null && pct >= e.opts.pausePct) {
      hold(e, 'usage', now);
      continue;
    }

    send(e, term, turns, now);
  }
}

export class KeepWarmError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/**
 * Turn keep-warm on, or change its settings. Pressing it is also you saying the
 * input box is empty right now, so earlier typing is forgotten — that is what
 * lets "Turn back on" after a typing stop mean something.
 */
export function enableKeepWarm(
  sessionId: string,
  file: string,
  opts: KeepWarmOptions,
  now = Date.now(),
): KeepWarmView {
  const term = termFor(sessionId);
  if (!term) throw new KeepWarmError('keep-warm needs this session running in a terminal of ours', 409);
  const turns = readTurns(file);
  if (!turns || turns.lastApiAt === null) {
    throw new KeepWarmError('nothing to keep warm yet: this session has not made an API call', 409);
  }
  const minutes = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(opts.minutes)));
  // Already running: this is a change of settings, not you vouching for the
  // input box, so the draft guard and the counters carry over.
  const running = entries.get(sessionId);
  if (running && !running.stopped) {
    running.opts = { ...opts, minutes };
    running.until = now + minutes * 60_000;
    return viewOf(running);
  }
  typedAt.delete(term.id);
  const e: Entry = {
    sessionId,
    file,
    opts: { ...opts, minutes },
    enabledAt: now,
    until: now + minutes * 60_000,
    clearSince: now,
    pings: 0,
    lastPingAt: null,
    awaiting: null,
    lastResult: null,
    misses: 0,
    held: null,
    heldSince: null,
    stopped: null,
  };
  entries.set(sessionId, e);
  return viewOf(e);
}

/**
 * The session has just been snoozed until `until`. If that is after keep-warm
 * would have ended anyway, stop it now: the cache will have expired long
 * before the session wakes, so every ping between now and then buys nothing.
 * A snooze that ends first leaves it running — out of sight and warm when it
 * comes back is the point of pairing the two.
 *
 * A stop, not a delete, so the keep-warm row can say why and offer to turn it
 * back on. Not a warning stop: you did this, so there is no popup about it.
 */
export function snoozeKeepWarm(sessionId: string, until: number, now = Date.now()): boolean {
  const e = entries.get(sessionId);
  if (!e || e.stopped || until <= e.until) return false;
  stop(e, 'snoozed', now);
  const term = termFor(sessionId);
  if (term) typedAt.delete(term.id);
  return true;
}

/**
 * You saying the input box is empty, while keep-warm runs: typing so far is
 * forgotten and the next ping goes as planned. For the warning that you have
 * typed since your last message, when what you typed was nothing — a stray
 * key while clicking into the pane, a draft you have since deleted.
 */
export function clearTypingKeepWarm(sessionId: string, now = Date.now()): KeepWarmView {
  const e = entries.get(sessionId);
  if (!e || e.stopped) throw new KeepWarmError('keep-warm is not on for this session', 409);
  e.clearSince = now;
  const term = termFor(sessionId);
  if (term) typedAt.delete(term.id);
  return viewOf(e);
}

/** Off, and forgotten — also how a stopped entry's warning is dismissed. */
export function disableKeepWarm(sessionId: string): boolean {
  const term = termFor(sessionId);
  if (term) typedAt.delete(term.id);
  return entries.delete(sessionId);
}

/**
 * Send a ping now, for a hold only you can judge — typically 'busy', where the
 * app cannot tell a long tool call from a stuck status but you can see the
 * terminal. The status check is the only one this skips.
 */
export function pingNow(sessionId: string, now = Date.now()): KeepWarmView {
  const e = entries.get(sessionId);
  if (!e || e.stopped) throw new KeepWarmError('keep-warm is not on for this session', 409);
  const term = termFor(sessionId);
  if (!term) throw new KeepWarmError('no running terminal for this session', 409);
  // One out at a time: a second would be appended to the first if it has not
  // submitted — the pile-up the no-reply stop exists to prevent.
  if (e.awaiting) throw new KeepWarmError('a ping is already out; wait for its reply', 409);
  const turns = readTurns(e.file);
  if (!turns) throw new KeepWarmError('could not read the transcript', 500);
  const blocker = hardBlocker(e, term, turns);
  if (blocker === 'waiting') throw new KeepWarmError('the session is stopped on a dialog; typing would answer it', 409);
  if (blocker === 'question') throw new KeepWarmError('the session is waiting for an answer to a question', 409);
  if (blocker === 'typed') {
    throw new KeepWarmError('you have typed in this terminal since your last message; clear the input box and turn keep-warm back on', 409);
  }
  send(e, term, turns, now);
  return viewOf(e);
}

function viewOf(e: Entry): KeepWarmView {
  const turns = e.stopped ? null : readTurns(e.file);
  const term = e.stopped ? null : termFor(e.sessionId);
  return {
    active: !e.stopped,
    enabledAt: e.enabledAt,
    until: e.until,
    untilSend: e.opts.untilSend,
    pausePct: e.opts.pausePct,
    pings: e.pings,
    lastPingAt: e.lastPingAt,
    awaitingReply: e.awaiting !== null,
    nextPingAt: turns?.lastApiAt != null ? turns.lastApiAt + PING_AFTER_MS : null,
    lastResult: e.lastResult,
    held: e.held,
    heldSince: e.heldSince,
    unsentSince: term && turns ? unsentTypingSince(e, term.id, turns) : null,
    stopped: e.stopped,
  };
}

export function keepWarmView(sessionId: string): KeepWarmView | null {
  const e = entries.get(sessionId);
  return e ? viewOf(e) : null;
}
