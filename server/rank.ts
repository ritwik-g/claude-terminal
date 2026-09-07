import type { GitInfo, LiveInfo, Session, SessionShape, SessionState, TailInfo, UserState } from './types.js';

const HOUR = 3600_000;

/**
 * `blocked` sits deliberately far above the rest rather than one notch above.
 * Every other state can climb on recency (+40), uncommitted files (+20),
 * unpushed commits (+5) and an open PR (+8), so the highest a `needs_you`
 * session can reach without a human marking it is 173. 200 keeps a question
 * abandoned three weeks ago above the freshest ordinary session, which is the
 * whole point: nothing there can proceed at all until you answer.
 *
 * Explicit priority and pinning still win, and should — those are you saying
 * what matters. scripts/test-blocked.ts holds this line, against a needs_you
 * session carrying every boost at once.
 */
const BASE_SCORE: Record<SessionState, number> = {
  blocked: 200,
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
 * Tools that stop and ask you to pick something. A dangling call to one of
 * these is not a session that died mid-work — it is a session standing at a
 * question, which is a completely different thing to do about it.
 */
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

function blockedOnQuestion(tail: TailInfo): boolean {
  return tail.pendingTools.some((t) => QUESTION_TOOLS.has(t));
}

/**
 * Decide what a session is doing right now.
 *
 * The live registry is authoritative when it exists — Claude Code tells us
 * busy/idle/waiting directly. Only for sessions with no running process, or
 * one that has not reported a status yet, do we read the transcript tail.
 */
export function deriveState(
  tail: TailInfo,
  live: LiveInfo | null,
  git: GitInfo | null,
  opts: { ownsCwd: boolean; hasPr: boolean; ageDays: number },
): SessionState {
  // Claude Code's own word for 'stopped on a dialog'. First-party and live, so
  // it beats anything inferred.
  if (live?.status === 'waiting') return 'blocked';
  if (live?.status === 'busy') return 'working';

  // The transcript catches what the registry cannot: a question nobody ever
  // answered, in a session whose process is long gone. That is not a crash —
  // it is the most forgettable thing this tool exists to remember.
  if (blockedOnQuestion(tail)) return 'blocked';

  // Running but not processing means the prompt is sitting there waiting.
  if (live?.status === 'idle') return 'needs_you';

  // 'unknown' is a live process that has not reported a status yet — the
  // sdk-cli entrypoint writes its registry file before its first report. It is
  // NOT idle: reading it that way put every just-launched session in the
  // attention bucket claiming to want you. Call it working, which is the
  // cheapest wrong answer available for a second or two and keeps the
  // invariant that a live session is never 'quiet'.
  if (live) return 'working';

  // No process, and it stopped holding a tool open.
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
    case 'blocked':
      reasons.push(blockedReason(args.tail, args.live));
      break;
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
  if ((state === 'needs_you' || state === 'blocked') && ageHours > 24) {
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

/**
 * Say what it is stuck on, most specific source first. The transcript knows
 * the actual question; the registry only knows a coarse label, and its default
 * for anything it has no entry for is the misleading-sounding 'permission
 * prompt' — an AskUserQuestion reports that too. So the transcript wins where
 * it has an answer, and the label is the fallback rather than the headline.
 */
function blockedReason(tail: TailInfo, live: LiveInfo | null): string {
  if (tail.pendingQuestion) return `asked: ${tail.pendingQuestion}`;
  if (tail.pendingTools.includes('ExitPlanMode')) return 'waiting for you to approve a plan';
  if (tail.pendingTools.includes('AskUserQuestion')) return 'waiting for an answer';
  // Quote the registry's label verbatim rather than building a sentence round
  // it. The labels are noun phrases with no consistent article — 'permission
  // prompt' takes one, 'input needed' and 'dialog open' do not — so anything
  // that prefixes 'a' produces "stopped on a input needed" on live sessions.
  if (live?.waitingFor) {
    const tool = tail.pendingTools[0];
    return tool ? `waiting: ${live.waitingFor} (${tool})` : `waiting: ${live.waitingFor}`;
  }
  return 'stopped on a prompt';
}

function formatAge(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Buckets the UI groups by. Snoozed and archived are filtered before this. */
export function bucketOf(s: Session, now = Date.now()): 'attention' | 'working' | 'parked' | 'quiet' | 'snoozed' {
  if (s.user.snoozedUntil && s.user.snoozedUntil > now) return 'snoozed';
  if (s.state === 'blocked' || s.state === 'needs_you' || s.state === 'crashed') return 'attention';
  if (s.state === 'working') return 'working';
  if (s.state === 'parked') return 'parked';
  return 'quiet';
}

/**
 * Every shape `classifyShape` can return, as a value.
 *
 * Derived from an exhaustive Record rather than written as a plain array: a
 * `readonly SessionShape[]` literal happily omits a member, which is exactly
 * how smoke.ts came to assert a hand-listed three shapes and go quietly red
 * the day `review` was added. A missing key here is a compile error.
 */
const SHAPE_KEYS: Record<SessionShape, true> = {
  errand: true, task: true, thread: true, review: true,
};
export const SESSION_SHAPES = Object.keys(SHAPE_KEYS) as SessionShape[];

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
