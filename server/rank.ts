import type { GitInfo, LiveInfo, Session, SessionShape, SessionState, TailInfo, UserState } from './types.js';

const HOUR = 3600_000;

const BASE_SCORE: Record<SessionState, number> = {
  needs_you: 100,
  crashed: 90,
  working: 60,
  parked: 40,
  quiet: 10,
};

const PRIORITY_BOOST = { p0: 300, p1: 150, p2: 50 } as const;

const PINNED_BOOST = 10_000;
const SNOOZED_PENALTY = -100_000;

/**
 * Decide what a session is doing right now.
 *
 * The live registry is authoritative when it exists — Claude Code tells us
 * busy/idle directly. Only for sessions with no running process do we fall
 * back to reading the transcript tail.
 */
export function deriveState(
  tail: TailInfo,
  live: LiveInfo | null,
  git: GitInfo | null,
  opts: { ownsCwd: boolean; hasPr: boolean; ageDays: number },
): SessionState {
  if (live) {
    if (live.status === 'busy') return 'working';
    // Running but not processing means the prompt is sitting there waiting.
    return 'needs_you';
  }
  // No process. Did it stop cleanly, or get cut off mid tool-call?
  if (tail.endedMidTool) return 'crashed';

  // 'Parked' has to mean *you* left something here, so it must be tied to work
  // this session can claim. Uncommitted files in a directory shared by dozens
  // of sessions are ambient repo state: attributing them to each session marked
  // 111 of 134 as parked and made the bucket meaningless.
  if (opts.ageDays > PARKED_MAX_AGE_DAYS) return 'quiet';
  const ownDirt = opts.ownsCwd && ((git?.dirty ?? 0) > 0 || (git?.ahead ?? 0) > 0);
  if (ownDirt || opts.hasPr) return 'parked';
  return 'quiet';
}

/** Past this, an untouched session is history rather than something parked. */
const PARKED_MAX_AGE_DAYS = 14;

export interface Scored {
  state: SessionState;
  score: number;
  reasons: string[];
}

export function score(args: {
  tail: TailInfo;
  live: LiveInfo | null;
  git: GitInfo | null;
  user: UserState;
  lastActivity: number;
  hasPr: boolean;
  /** true when this session is the only one working in its cwd (or a worktree) */
  ownsCwd: boolean;
  now?: number;
}): Scored {
  const now = args.now ?? Date.now();
  const ageDaysForState = Math.max(0, (now - args.lastActivity) / (24 * HOUR));
  const state = deriveState(args.tail, args.live, args.git, {
    ownsCwd: args.ownsCwd,
    hasPr: args.hasPr,
    ageDays: ageDaysForState,
  });
  const reasons: string[] = [];
  let total = BASE_SCORE[state];

  switch (state) {
    case 'needs_you':
      reasons.push('waiting on you');
      break;
    case 'working':
      reasons.push('running now');
      break;
    case 'crashed':
      reasons.push('stopped mid tool-call');
      break;
    case 'parked':
      reasons.push('work left behind');
      break;
  }

  // Recency: what you touched recently is what you are actually doing.
  const ageHours = Math.max(0, (now - args.lastActivity) / HOUR);
  const recency = Math.round(40 * Math.exp(-ageHours / 12));
  if (recency >= 5) {
    total += recency;
    reasons.push(`active ${formatAge(ageHours)} ago`);
  }

  // A question left unanswered for a day is a different problem from a live
  // one — it is forgotten rather than in-flight, so surface it deliberately.
  if (state === 'needs_you' && ageHours > 24) {
    total += 25;
    reasons.push(`unanswered for ${formatAge(ageHours)}`);
  }

  // Only surface git state the session can actually claim; see deriveState.
  const dirty = args.ownsCwd ? args.git?.dirty ?? 0 : 0;
  if (dirty > 0) {
    total += Math.min(dirty, 10) * 2;
    reasons.push(`${dirty} uncommitted file${dirty === 1 ? '' : 's'}`);
  }

  const ahead = args.ownsCwd ? args.git?.ahead ?? 0 : 0;
  if (ahead > 0) {
    total += 5;
    reasons.push(`${ahead} unpushed commit${ahead === 1 ? '' : 's'}`);
  }

  if (args.hasPr) {
    total += 8;
    reasons.push('has a PR');
  }

  if (args.git?.isWorktree) reasons.push('worktree');

  if (args.user.priority) {
    total += PRIORITY_BOOST[args.user.priority];
    reasons.push(args.user.priority.toUpperCase());
  }

  if (args.user.pinned) {
    total += PINNED_BOOST;
    reasons.push('pinned');
  }

  if (args.user.snoozedUntil && args.user.snoozedUntil > now) {
    total += SNOOZED_PENALTY;
    reasons.push(`snoozed until ${new Date(args.user.snoozedUntil).toLocaleString()}`);
  }

  return { state, score: total, reasons };
}

function formatAge(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Buckets the UI groups by. Snoozed and archived are filtered before this. */
export function bucketOf(s: Session, now = Date.now()): 'attention' | 'working' | 'parked' | 'quiet' | 'snoozed' {
  if (s.user.snoozedUntil && s.user.snoozedUntil > now) return 'snoozed';
  if (s.state === 'needs_you' || s.state === 'crashed') return 'attention';
  if (s.state === 'working') return 'working';
  if (s.state === 'parked') return 'parked';
  return 'quiet';
}

/**
 * Separate the ad-hoc errands from the long-running explorations.
 *
 * Thresholds come from the real distribution across 134 sessions rather than
 * intuition: session span is strongly bimodal — p25 is 28 minutes, p50 is 21
 * hours, p75 is 4.75 days, and the tail runs to 67 days. Size corroborates
 * span (p75 = 2.8MB, p90 = 4.9MB), and catches the case of a heavy session
 * hammered through in one sitting.
 */
export function classifyShape(
  startedAt: number,
  lastActivity: number,
  sizeBytes: number,
  isReview = false,
): SessionShape {
  // What a session is FOR beats how long it ran. A review that turned into a
  // three-day remediation loop is still a review, and classifying it as a
  // thread buries it among the explorations you were trying to filter away.
  if (isReview) return 'review';
  const spanHours = Math.max(0, (lastActivity - startedAt) / HOUR);
  const mb = sizeBytes / (1024 * 1024);
  if (spanHours >= 72 || mb >= 4) return 'thread';
  if (spanHours < 2 && mb < 1) return 'errand';
  return 'task';
}
