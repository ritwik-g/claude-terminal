import type { KeepWarmHold, KeepWarmStop, KeepWarmView, Session, SessionShape, SessionState } from '../../server/types';

export const STATE_COLOR: Record<SessionState, string> = {
  blocked: 'var(--st-blocked)',
  needs_you: 'var(--st-needs)',
  working: 'var(--st-working)',
  crashed: 'var(--st-crashed)',
  parked: 'var(--st-parked)',
  quiet: 'var(--st-quiet)',
};

export const STATE_LABEL: Record<SessionState, string> = {
  blocked: 'stopped on a question',
  needs_you: 'waiting on you',
  working: 'running',
  crashed: 'stopped mid tool-call',
  parked: 'parked',
  quiet: 'quiet',
};

export const SHAPE_LABEL: Record<SessionShape, string> = {
  review: 'Reviews',
  errand: 'Errands',
  task: 'Tasks',
  thread: 'Threads',
};

export const SHAPE_GLYPH: Record<SessionShape, string> = {
  review: '\u2713',
  errand: '\u26a1',
  task: '\u25c6',
  thread: '\u221e',
};

export const SHAPE_HINT: Record<SessionShape, string> = {
  review: 'Opened with a review command \u2014 links the PRs it covers',
  errand: 'Short, single-purpose \u2014 a quick question or a one-off fix',
  task: 'A normal piece of work',
  thread: 'A long-running exploration carried across days',
};

export const SHAPE_ORDER: SessionShape[] = ['review', 'errand', 'task', 'thread'];

export type Bucket = 'attention' | 'working' | 'parked' | 'quiet' | 'snoozed';

export const BUCKET_ORDER: Bucket[] = ['attention', 'working', 'parked', 'quiet', 'snoozed'];

export const BUCKET_LABEL: Record<Bucket, string> = {
  attention: 'Needs you',
  working: 'Working',
  parked: 'Parked',
  quiet: 'Quiet',
  snoozed: 'Snoozed',
};

/** What each group actually means, for the help dialog. */
export const BUCKET_HELP: Record<Bucket, string> = {
  attention: 'Claude is stopped on a question it cannot pass, has finished its turn and is waiting on you, or stopped mid tool-call. Questions sort to the top \u2014 nothing in them can move until you answer',
  working: 'running right now',
  parked: 'idle, but with uncommitted changes or an open PR left behind',
  quiet: 'nothing pending',
  snoozed: 'set aside until the snooze runs out',
};

export const BUCKET_COLOR: Record<Bucket, string> = {
  attention: 'var(--st-needs)',
  working: 'var(--st-working)',
  parked: 'var(--st-parked)',
  quiet: 'var(--st-quiet)',
  snoozed: 'var(--fg-dim)',
};

/**
 * What "active" means: a Claude Code process is running for this session right
 * now — either registered in ~/.claude/sessions, or attached to a terminal in
 * this app.
 *
 * `attached` is not redundant. A session you have just opened here spawns its
 * PTY immediately but takes a second or two to register itself as live, and
 * without this the row would vanish from under you at the exact moment you
 * opened it.
 */
export const isActive = (s: Session): boolean => !!s.live || s.attached;

export function bucketOf(s: Session, now = Date.now()): Bucket {
  if (s.user.snoozedUntil && s.user.snoozedUntil > now) return 'snoozed';
  if (s.state === 'blocked' || s.state === 'needs_you' || s.state === 'crashed') return 'attention';
  if (s.state === 'working') return 'working';
  if (s.state === 'parked') return 'parked';
  return 'quiet';
}

/** "just now" or "5m ago", for a sentence — relTime alone reads "now ago". */
export function agoText(ts: number, now = Date.now()): string {
  const r = relTime(ts, now);
  return r === 'now' ? 'just now' : `${r} ago`;
}

export function relTime(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts);
  const m = d / 60_000;
  if (m < 1) return 'now';
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h`;
  const days = h / 24;
  if (days < 7) return `${Math.round(days)}d`;
  const w = days / 7;
  if (w < 5) return `${Math.round(w)}w`;
  return `${Math.round(days / 30)}mo`;
}

export function shortPath(p: string): string {
  const home = '/Users/';
  if (p.startsWith(home)) {
    const rest = p.slice(home.length);
    const slash = rest.indexOf('/');
    return slash >= 0 ? `~${rest.slice(slash)}` : '~';
  }
  return p;
}

/**
 * The leading chunk of a session id — what Claude Code itself shows you in
 * `--resume` and what names the transcript file. Long enough to be unique
 * across any realistic number of sessions, short enough to read at a glance.
 */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * A term that is really a transcript path or filename means the session that
 * owns it: `…/b0b0bcc6-….jsonl` should find b0b0bcc6. Anything else is left
 * exactly as typed, so searching a cwd like `~/my-project` still works.
 */
function normalizeTerm(t: string): string {
  if (!t.endsWith('.jsonl')) return t;
  return t.slice(t.lastIndexOf('/') + 1, -'.jsonl'.length);
}

/**
 * Ids are hex, so folding one into the free-text haystack would make short
 * terms match at random — 'ab' appears in roughly half of all UUIDs. Match
 * them deliberately instead: by prefix, which covers both the 8 chars shown in
 * the list and a whole id pasted in, and by an inner chunk only once the term
 * is long enough to be meant.
 */
function idMatches(id: string, t: string): boolean {
  if (t.length < 3) return false;
  if (id.startsWith(t)) return true;
  return t.length >= 8 && id.includes(t);
}

/** Matches on everything a person might remember about a session. */
export function matches(s: Session, q: string): boolean {
  if (!q) return true;
  const hay = [
    s.title, s.lastPrompt, s.recap, s.branch, s.cwd,
    s.user.tags.join(' '), s.user.note,
    s.pr ? `pr #${s.pr.number} ${s.pr.repository}` : '',
    // The derived review marker is searchable by the command that produced it,
    // so 'pr-review' finds the review sessions without anyone having to tag
    // them by hand — and the PR under review is findable by number too.
    s.review ? `${s.review.command} review` : '',
    // Every PR the review covers, not just the first — otherwise searching the
    // number of the second PR in a two-PR review finds nothing.
    (s.review?.prs ?? []).map((p) => `pr #${p.number} ${p.repository}`).join(' '),
    s.user.priority ?? '',
    // So 'cleanup' in the search box finds the marked sessions, the same way
    // 'review' finds the derived review ones.
    s.user.cleanup ? 'cleanup' : '',
    s.shape,
  ].join(' ').toLowerCase();
  const id = s.id.toLowerCase();
  // every whitespace-separated term must appear somewhere
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((raw) => {
    const t = normalizeTerm(raw);
    return hay.includes(t) || idMatches(id, t);
  });
}

/* ------------------------------------------------------------- usage windows

   Shared by the usage pill and the alerts that watch the same numbers. They
   live here rather than in the pill because an alert has to answer exactly the
   questions the pill answers — has this window rolled over, when does it end,
   how bad is this percentage — and a second copy of "bad" would let a banner
   go amber while the pill beside it was still green. */

/** Amber once the window is worth watching, red once it is worth planning around. */
export function usageColor(percent: number): string {
  if (percent >= 90) return 'var(--st-crashed)';
  if (percent >= 70) return 'var(--st-needs)';
  return 'var(--st-working)';
}

const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const WEEKDAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const DATE_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

/** Whole calendar days from `now` to `at`, DST-safe because it compares midnights. */
function dayOffset(at: number, now: number): number {
  const a = new Date(at);
  const b = new Date(now);
  a.setHours(0, 0, 0, 0);
  b.setHours(0, 0, 0, 0);
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}

/**
 * The wall-clock time a window rolls over — the thing you actually plan around.
 *
 * A countdown makes you do arithmetic against your own calendar to answer "is
 * it back before my 3pm?", and it is wrong the moment you look away. The date
 * part appears only when the reset is not today, because "2:20 PM" for
 * something four hours out needs no qualification and "Mon 2:20 PM" for
 * something four hours out is noise.
 */
export function clockTime(at: number | null, now: number): string {
  if (at === null) return 'unknown';
  const time = TIME_FMT.format(at);
  const days = dayOffset(at, now);
  if (days <= 0) return time;
  if (days === 1) return `${time} tomorrow`;
  // Past a week a weekday name is ambiguous — "Tue" could be either one.
  if (days < 7) return `${WEEKDAY_FMT.format(at)} ${time}`;
  return `${DATE_FMT.format(at)} ${time}`;
}

export function resetsIn(at: number | null, now: number): string {
  if (at === null) return 'unknown';
  const mins = Math.round((at - now) / 60_000);
  if (mins <= 0) return 'any moment';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  // The weekly window is days away, and "102h 17m" makes the reader do the
  // division. Minutes stop being interesting long before that.
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return `${hours}h ${mins % 60}m`;
}

/**
 * Whether the window this reading describes has already rolled over.
 *
 * The percentage is only meaningful until its own reset time; past that the
 * window emptied and started again, so the number is not merely old, it is
 * about a window that no longer exists. This is a sharper test than the
 * one-hour staleness rule and independent of it — a reading taken twenty
 * minutes ago is not stale, but if its reset fell ten minutes ago the figure
 * is still describing the wrong window.
 */
export function windowExpired(w: { resetsAt: number | null }, now: number): boolean {
  return w.resetsAt !== null && w.resetsAt <= now;
}

/* ------------------------------------------------------------------ context */

/**
 * A context size at a glance: '184k', '9.6k', '780'.
 *
 * Rounded hard on purpose. The number moves by a few hundred tokens every turn
 * and nobody is comparing two sessions to four significant figures — what the
 * reader wants is the order of magnitude and whether it is bigger than the one
 * below it.
 */
export function formatTokens(n: number): string {
  if (n <= 0) return '—';
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k < 10 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
}

/* -------------------------------------------------------------- prompt cache */

/**
 * When this session's prompt cache expires, epoch ms, or null when it has made
 * no API call we know of. The cache lives for `cacheTtlMs` from the last call
 * that read or wrote it; the next turn after that rewrites the whole context
 * into the cache, at about twice the input price.
 */
export function cacheExpiresAt(s: Session): number | null {
  return s.lastApiAt > 0 ? s.lastApiAt + s.cacheTtlMs : null;
}

/** Milliseconds of cache left; zero or less once it has expired. Null when unknown. */
export function cacheLeftMs(s: Session, now: number): number | null {
  const at = cacheExpiresAt(s);
  return at === null ? null : at - now;
}

/** How many sessions the cache bar lists at once. */
const MAX_EXPIRING = 4;

/** What makes a cache worth a warning: how close, and how big. */
export interface CacheRisk {
  leadMs: number;
  minTokens: number;
}

/**
 * Whether this session is worth compacting right now: running, big, nothing
 * keeping it warm, and its prompt cache about to expire.
 *
 * Tied to the cache rather than to size alone. A compact reads the whole
 * context, so while the cache is there it costs about a tenth of the input
 * price and leaves a small context to come back to; once the cache has gone it
 * costs a full rewrite of its own, and simply carrying on is no dearer. Size
 * on its own said nothing about which of those you were in.
 *
 * Only live sessions, because a closed one is not going to take a turn soon,
 * and only big ones: Claude Code's own system prompt is cached separately, so
 * a small conversation's rebuild costs next to nothing.
 *
 * The same test backs the row chip and the cache bar, so the marker on a row
 * and the offer in the bar never disagree.
 */
export function worthCompacting(s: Session, risk: CacheRisk, now: number): boolean {
  if (!s.live || s.user.archived || s.keepWarm?.active) return false;
  if (s.contextTokens < risk.minTokens) return false;
  const left = cacheLeftMs(s, now);
  return left !== null && left > 0 && left <= risk.leadMs;
}

/**
 * Running sessions whose cache is about to expire and that nothing is keeping
 * warm, soonest first — worthCompacting, minus the ones you have snoozed.
 *
 * Only while the cache is still there. Once it has gone, the next turn pays
 * the rewrite whatever you do, so an expired session is not a warning, it is
 * history.
 */
export function cacheExpiring(sessions: Session[], risk: CacheRisk, now: number): Session[] {
  return sessions
    .filter((s) => worthCompacting(s, risk, now) && !(s.user.snoozedUntil && s.user.snoozedUntil > now))
    .sort((a, b) =>
      (cacheExpiresAt(a) ?? 0) - (cacheExpiresAt(b) ?? 0) || (a.id < b.id ? -1 : 1))
    .slice(0, MAX_EXPIRING);
}

/**
 * Whether snoozing this session until `until` is worth a "compact first?"
 * question: it is big, its cache is still warm, a terminal of ours can take
 * the /compact, and the cache will have expired before the session wakes.
 *
 * Not when keep-warm covers the whole snooze, and not once the cache has gone:
 * then compacting costs a full rewrite of its own, and carrying on later is
 * no dearer.
 */
export function compactBeforeSnooze(s: Session, until: number, minTokens: number, now: number): boolean {
  if (!s.attached || !s.termId || s.user.archived) return false;
  if (s.contextTokens < minTokens) return false;
  const at = cacheExpiresAt(s);
  if (at === null || at <= now || until <= at) return false;
  if (s.keepWarm?.active && until <= s.keepWarm.until) return false;
  return true;
}

/* ----------------------------------------------------------- break reminders */

export type BreakKind = 'lunch' | 'day-end';

/** How long after its time a break reminder stays up, unless dismissed. */
export const BREAK_WINDOW_MS = 60 * 60_000;

/** How many sessions a break reminder lists at once. */
const MAX_BREAK = 6;

export interface BreakSlot {
  kind: BreakKind;
  /** When it was due today, epoch ms. */
  at: number;
  /** Identity: the kind and the local date, so each fires once a day. */
  key: string;
}

/**
 * The break reminder that is due now, or null.
 *
 * `times` are minutes past local midnight, null for a reminder that is off.
 * Due from its time for BREAK_WINDOW_MS: long enough to still catch you if the
 * app was not open at the minute itself, short enough that an evening's work
 * is not interrupted by the afternoon's reminder. When two overlap, the later
 * one wins.
 */
export function breakDue(
  now: number,
  times: Record<BreakKind, number | null>,
): BreakSlot | null {
  let best: BreakSlot | null = null;
  for (const kind of ['lunch', 'day-end'] as BreakKind[]) {
    const mins = times[kind];
    if (mins === null) continue;
    // Built on a local Date, not by adding milliseconds to midnight, so 4 PM
    // stays 4 PM on the day the clocks change.
    const d = new Date(now);
    d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
    const at = d.getTime();
    if (at > now || now - at >= BREAK_WINDOW_MS) continue;
    if (best && best.at >= at) continue;
    const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    best = { kind, at, key: `${kind}:${day}` };
  }
  return best;
}

/**
 * Running sessions that still have a warm cache and are big enough to matter,
 * biggest first: what is worth dealing with before you step away.
 *
 * Unlike the expiry warning this does not wait for the cache to be nearly
 * gone — at the start of a break, one with 50 minutes left will still have
 * expired by the time you are back. Sessions kept warm are left out of a
 * lunch reminder, since keep-warm already covers a short break, but not out of
 * the end-of-day one: keep-warm stops after 12 hours at most, which is not the
 * morning, and pinging a big context all night costs about what the rewrite
 * it saves would.
 */
export function breakCandidates(
  sessions: Session[],
  kind: BreakKind,
  minTokens: number,
  now: number,
): Session[] {
  return sessions
    .filter((s) => {
      if (!s.live || s.user.archived) return false;
      if (s.user.snoozedUntil && s.user.snoozedUntil > now) return false;
      if (kind === 'lunch' && s.keepWarm?.active) return false;
      if (s.contextTokens < minTokens) return false;
      const left = cacheLeftMs(s, now);
      return left !== null && left > 0;
    })
    .sort((a, b) => b.contextTokens - a.contextTokens || (a.id < b.id ? -1 : 1))
    .slice(0, MAX_BREAK);
}

/** "34m", "1h 5m" — how long a cache has left, for a chip. */
export function formatLeft(ms: number): string {
  const mins = Math.max(1, Math.ceil(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/* ------------------------------------------------------------------- snooze */

const WEEKEND = new Set([0, 6]);

/**
 * When a "tomorrow" or "next week" snooze should actually wake, given a wake
 * time in minutes past local midnight.
 *
 * `minDays` is the earliest acceptable day — 1 for tomorrow, 7 for next week —
 * and the result then slides forward over weekends. A Friday-evening "tomorrow"
 * lands on Monday morning rather than on a Saturday you were not going to look
 * at, which is the whole point of snoozing until tomorrow rather than for 24
 * hours: you are naming the next time you will be at your desk, not an interval.
 *
 * Built by mutating a local Date rather than by adding milliseconds, so it
 * stays correct across a DST boundary: 9am is 9am on either side of one, where
 * `now + 24h` quietly becomes 8am or 10am.
 */
export function wakeAt(now: number, minDays: number, wakeMinutes: number): number {
  const d = new Date(now);
  d.setDate(d.getDate() + minDays);
  d.setHours(Math.floor(wakeMinutes / 60), wakeMinutes % 60, 0, 0);
  // A same-day wake time that has already passed would unsnooze instantly.
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  while (WEEKEND.has(d.getDay())) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Minutes past midnight as '09:00', for a time input. */
export function minutesToHHMM(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** '09:00' back to minutes past midnight, or null if it is not a time. */
export function hhmmToMinutes(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * How long a snooze has been over, or null when it is not a session that has
 * recently woken.
 *
 * `snoozedUntil` is not cleared when it lapses — ranking simply stops honouring
 * it — which means the record of "this was set aside until now" is still there
 * to read. That is the only trace a woken session leaves: it rejoins the list
 * silently, in whatever position its score earns, among rows that never went
 * anywhere. Reading the lapsed timestamp back is what lets the row say so.
 *
 * The window is deliberately generous. A session that woke while you were at
 * lunch should still be marked when you get back, and the marker is cleared by
 * opening the session anyway, so its only cost is on sessions you did not look
 * at — which is exactly who it is for.
 */
export const WOKE_WINDOW_MS = 8 * 3600_000;

export function wokeAgo(s: Session, now: number): number | null {
  const until = s.user.snoozedUntil;
  if (until === null || until > now) return null;
  const since = now - until;
  return since <= WOKE_WINDOW_MS ? since : null;
}

/**
 * Keep-warm durations offered in the detail pane. Every one ends: about twenty
 * pings cost what one cold resume does, so "keep it warm forever" is the one
 * option that is never the cheap one. "Until I reply" still has a ceiling, the
 * server's own 12 hours.
 */
export const KEEPWARM_OPTIONS: { label: string; minutes: number; untilSend: boolean; hint: string }[] = [
  { label: '2h', minutes: 120, untilSend: false, hint: 'Keep the cache warm for the next 2 hours' },
  { label: '4h', minutes: 240, untilSend: false, hint: 'Keep the cache warm for the next 4 hours' },
  { label: '8h', minutes: 480, untilSend: false, hint: 'Keep the cache warm for the next 8 hours' },
  {
    label: 'until I reply', minutes: 720, untilSend: true,
    hint: 'Keep the cache warm until you next send a message here, for at most 12 hours',
  },
];

/** Why a due ping is waiting, in words. */
export const KEEPWARM_HOLD_TEXT: Record<KeepWarmHold, string> = {
  busy: 'the session reports it is busy',
  unknown: 'the session has not reported a status yet',
  'no-status': 'the session is not reporting a status',
  waiting: 'the session is stopped on a dialog',
  question: 'the session is waiting for an answer',
  usage: 'the 5-hour window is past your alert threshold',
  'no-turn': 'there is no turn to time the next ping from',
};

/** Holds where only you can judge whether typing is safe, so Ping anyway is offered. */
export const KEEPWARM_OVERRIDABLE: ReadonlySet<KeepWarmHold> = new Set(['busy', 'unknown', 'no-status', 'usage']);

/** Why keep-warm stopped, in words. */
export const KEEPWARM_STOP_TEXT: Record<KeepWarmStop, string> = {
  typed: 'you typed in this terminal without sending it. Clear the input box, then turn it back on',
  'cache-miss': 'pings sent inside the hour kept missing the cache, so they were not saving anything',
  'terminal-closed': 'no terminal of ours is running this session any more — it closed, or /branch moved it to a new session',
  'no-reply': 'a ping did not start a turn. Check the input box for leftover text before turning it back on',
  expired: 'its time ran out',
  sent: 'you sent a message',
  snoozed: 'you snoozed this session past when keep-warm would end, so the cache would have expired before it woke anyway',
};

/** Stops that are a problem, not keep-warm finishing what you asked. Mirrors the server's WARN_STOPS. */
export const KEEPWARM_WARN: ReadonlySet<KeepWarmStop> = new Set(['typed', 'cache-miss', 'terminal-closed', 'no-reply']);

export const KEEPWARM_RESULT_TEXT: Record<NonNullable<KeepWarmView['lastResult']>, string> = {
  hit: 'last ping hit the cache',
  miss: 'last ping missed the cache',
  cold: 'last ping rebuilt an expired cache',
};

/**
 * The row's keep-warm chip, or null for none. A stop that is just keep-warm
 * finishing is not worth a chip; one that needs you is.
 */
export function keepWarmChip(
  kw: KeepWarmView | null,
  now: number,
): { label: string; cls: string; title: string } | null {
  if (!kw) return null;
  if (kw.stopped) {
    // Snoozed is not a warning, but it is worth a chip: it is the one stop
    // you caused without asking for it by name.
    if (!KEEPWARM_WARN.has(kw.stopped.reason) && kw.stopped.reason !== 'snoozed') return null;
    return {
      label: 'warm off',
      cls: 'chip kw off',
      title: `Keep-warm stopped ${agoText(kw.stopped.at, now)}: ${KEEPWARM_STOP_TEXT[kw.stopped.reason]}`,
    };
  }
  if (kw.held) {
    return {
      label: 'warm ‖',
      cls: 'chip kw held',
      title: `Keep-warm is holding its ping: ${KEEPWARM_HOLD_TEXT[kw.held]}`,
    };
  }
  const next = kw.awaitingReply
    ? ' · ping sent, waiting for the reply'
    : kw.nextPingAt ? ` · next ping ${clockTime(kw.nextPingAt, now)}` : '';
  return {
    label: 'warm',
    cls: 'chip kw',
    title: `Keeping the prompt cache warm until ${clockTime(kw.until, now)}${next}` +
      (kw.lastResult ? ` · ${KEEPWARM_RESULT_TEXT[kw.lastResult]}` : ''),
  };
}
