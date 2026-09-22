import type { Session, SessionShape, SessionState } from '../../server/types';

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

/**
 * Whether this session is one worth offering to compact.
 *
 * ACTIVE only. A 800k-token session that nothing is running against is not
 * spending anything — it is a fact about a conversation you might resume one
 * day, not a cost you are paying now — and on a real tree most big sessions
 * are of that kind. Flagging them all buried the two or three that are
 * actually burning the window under a column of numbers nobody reads, which is
 * the precise failure this predicate exists to avoid.
 *
 * The same test backs the row chip and the alert bar's list, so the marker on
 * a row and the offer in the bar can never disagree about what counts.
 */
export function worthCompacting(s: Session, above: number): boolean {
  return above > 0 && s.contextTokens >= above && !s.user.archived && isActive(s);
}

/** How many compaction candidates the alert bar offers. */
const MAX_CANDIDATES = 4;

/**
 * Sessions worth compacting, heaviest first, with the ones you can act on
 * immediately at the front.
 *
 * Attached sessions sort first because they are the only ones the app can do
 * anything about — a /compact goes to a terminal this app owns. A session
 * running in a terminal of your own is still listed, because it is still
 * spending the window; it just has to be compacted where it is running.
 *
 * Four, because the bar is a strip across the top of the window rather than a
 * list view, and the fifth-heaviest session is never the one that decides
 * whether you make it to the reset.
 */
export function compactionCandidates(sessions: Session[], above: number): Session[] {
  return sessions
    .filter((s) => worthCompacting(s, above))
    .sort((a, b) =>
      Number(b.attached) - Number(a.attached) ||
      b.contextTokens - a.contextTokens ||
      (a.id < b.id ? -1 : 1))
    .slice(0, MAX_CANDIDATES);
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
