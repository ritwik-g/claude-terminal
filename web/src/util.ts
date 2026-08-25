import type { Session, SessionShape, SessionState } from '../../server/types';

export const STATE_COLOR: Record<SessionState, string> = {
  needs_you: 'var(--st-needs)',
  working: 'var(--st-working)',
  crashed: 'var(--st-crashed)',
  parked: 'var(--st-parked)',
  quiet: 'var(--st-quiet)',
};

export const STATE_LABEL: Record<SessionState, string> = {
  needs_you: 'waiting on you',
  working: 'running',
  crashed: 'stopped mid tool-call',
  parked: 'parked',
  quiet: 'quiet',
};

export const SHAPE_LABEL: Record<SessionShape, string> = {
  errand: 'Errands',
  task: 'Tasks',
  thread: 'Threads',
};

export const SHAPE_GLYPH: Record<SessionShape, string> = {
  errand: '\u26a1',
  task: '\u25c6',
  thread: '\u221e',
};

export const SHAPE_HINT: Record<SessionShape, string> = {
  errand: 'Short, single-purpose \u2014 a PR review or a quick question',
  task: 'A normal piece of work',
  thread: 'A long-running exploration carried across days',
};

export const SHAPE_ORDER: SessionShape[] = ['errand', 'task', 'thread'];

export type Bucket = 'attention' | 'working' | 'parked' | 'quiet' | 'snoozed';

export const BUCKET_ORDER: Bucket[] = ['attention', 'working', 'parked', 'quiet', 'snoozed'];

export const BUCKET_LABEL: Record<Bucket, string> = {
  attention: 'Needs you',
  working: 'Working',
  parked: 'Parked',
  quiet: 'Quiet',
  snoozed: 'Snoozed',
};

export const BUCKET_COLOR: Record<Bucket, string> = {
  attention: 'var(--st-needs)',
  working: 'var(--st-working)',
  parked: 'var(--st-parked)',
  quiet: 'var(--st-quiet)',
  snoozed: 'var(--fg-dim)',
};

export function bucketOf(s: Session, now = Date.now()): Bucket {
  if (s.user.snoozedUntil && s.user.snoozedUntil > now) return 'snoozed';
  if (s.state === 'needs_you' || s.state === 'crashed') return 'attention';
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

/** Matches on everything a person might remember about a session. */
export function matches(s: Session, q: string): boolean {
  if (!q) return true;
  const hay = [
    s.title, s.lastPrompt, s.recap, s.branch, s.cwd,
    s.user.tags.join(' '), s.user.note,
    s.pr ? `pr #${s.pr.number} ${s.pr.repository}` : '',
    s.user.priority ?? '',
    s.shape,
  ].join(' ').toLowerCase();
  // every whitespace-separated term must appear somewhere
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}
