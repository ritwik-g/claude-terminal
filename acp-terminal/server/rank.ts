import type { AcpSession, SessionState } from './types.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

const BASE_SCORE: Record<SessionState, number> = {
  blocked: 200,
  needs_you: 100,
  crashed: 90,
  working: 60,
  parked: 40,
  quiet: 10,
  snoozed: -100_000,
};

const PRIORITY_BOOST = {
  p0: 300,
  p1: 150,
  p2: 50,
} as const;

const PINNED_BOOST = 10_000;
const SNOOZED_PENALTY = -100_000;

/** Background shells, workflows or async subagents still running after the turn ended. */
export function hasRunningBackground(s: Pick<AcpSession, 'agentTasks' | 'turns'>): boolean {
  if (s.agentTasks?.some((t) => t.status === 'running')) return true;
  return Boolean(s.turns?.some((t) => t.toolCalls?.some((c) => c.background && (c.backgroundState ?? 'running') === 'running')));
}

/**
 * The turn ended but work the agent started still runs, and the agent picks up again when it
 * finishes: nothing is needed from the user yet. The state stays needs_you so a message is
 * sent straight away rather than queued behind a turn.
 */
export function isWorkingInBackground(s: Pick<AcpSession, 'agentTasks' | 'turns'>, state: SessionState): boolean {
  return state === 'needs_you' && hasRunningBackground(s);
}

export function deriveSessionState(session: Pick<AcpSession, 'pendingPermission' | 'pendingElicitation' | 'turns' | 'git' | 'user' | 'state' | 'agentStopped'>): SessionState {
  // Check snooze first
  if (session.user?.snoozedUntil && session.user.snoozedUntil > Date.now()) {
    return 'snoozed';
  }

  // If there is an active permission or question request waiting for user response
  if (session.pendingPermission || session.pendingElicitation) {
    return 'blocked';
  }

  // If session is actively working on a turn
  if (session.state === 'working') {
    return 'working';
  }

  // If marked crashed
  if (session.state === 'crashed') {
    return 'crashed';
  }

  // The user stopped the agent process: keep it parked until they start it or send a prompt
  if (session.agentStopped) {
    return 'parked';
  }

  // If the agent just completed its response, it needs the user's attention/input
  const lastTurn = session.turns?.[session.turns.length - 1];
  if (lastTurn && lastTurn.role === 'agent') {
    return 'needs_you';
  }

  if (session.state === 'needs_you') {
    return 'needs_you';
  }

  // Idle states: differentiate by git repository state (e.g. uncommitted changes paused by user)
  if (session.git && (!session.git.isClean || session.git.uncommittedFiles > 0 || session.git.unpushedCommits > 0)) {
    return 'parked';
  }

  if (session.turns && session.turns.length > 0) {
    return 'needs_you';
  }

  return 'quiet';
}

/** One thing that moved a session's attention score, in words the user would use. */
export interface RankFactor {
  label: string;
  points: number;
}

export interface RankResult {
  score: number;
  state: SessionState;
  /** Plain-language factors, in the order the rules apply. */
  factors: RankFactor[];
  /** One sentence saying why the session sits where it does. */
  summary: string;
  /** The factors as "label (+points)" strings, for logs and older clients. */
  reasons: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 2) return 'just now';
  if (min < 60) return `${min} minutes ago`;
  const h = Math.round(min / 60);
  return h === 1 ? 'an hour ago' : `${h} hours ago`;
}

function until(ts: number): string {
  const min = Math.max(1, Math.round((ts - Date.now()) / 60_000));
  if (min < 60) return `for another ${plural(min, 'minute')}`;
  const h = Math.round(min / 60);
  return h < 48 ? `for another ${plural(h, 'hour')}` : `for another ${plural(Math.round(h / 24), 'day')}`;
}

function stateFactor(session: AcpSession, state: SessionState): { label: string; sentence: string } {
  const git = session.git;
  switch (state) {
    case 'blocked': {
      const question = session.pendingPermission ? undefined : session.pendingElicitation?.message.trim().replace(/\s+/g, ' ');
      if (question !== undefined) {
        return {
          label: 'Waiting for your answer',
          sentence: question ? `The agent is waiting for your answer to “${question}”.` : 'The agent is waiting for your answer.',
        };
      }
      const title = session.pendingPermission?.title;
      return {
        label: 'Waiting for your approval',
        sentence: title ? `The agent is waiting for you to approve “${title}”.` : 'The agent is waiting for your approval.',
      };
    }
    case 'needs_you':
      return { label: 'Waiting for your reply', sentence: 'The agent has finished and is waiting for your reply.' };
    case 'crashed':
      return { label: 'The agent crashed', sentence: 'The agent crashed; restart it to carry on.' };
    case 'working':
      return { label: 'The agent is working', sentence: 'The agent is working on it; nothing is needed from you yet.' };
    case 'parked':
      if (session.agentStopped) return { label: 'You stopped the agent', sentence: 'You stopped the agent, so it waits until you start it again.' };
      return {
        label: 'Idle with unsaved work',
        sentence:
          git && git.uncommittedFiles > 0
            ? `Nothing is running, but ${plural(git.uncommittedFiles, 'file')} ${git.uncommittedFiles === 1 ? 'is' : 'are'} not committed yet.`
            : 'Nothing is running, but there is work that has not been pushed.',
      };
    case 'snoozed':
      return {
        label: 'Snoozed',
        sentence: `Snoozed ${until(session.user.snoozedUntil ?? Date.now())}, so it stays at the bottom.`,
      };
    default:
      return { label: 'Idle', sentence: 'Nothing is happening in this session.' };
  }
}

export function rankSession(session: AcpSession): RankResult {
  const state = deriveSessionState(session);
  const factors: RankFactor[] = [];
  const add = (label: string, points: number) => factors.push({ label, points });

  const inBackground = isWorkingInBackground(session, state);
  const base = inBackground
    ? { label: 'Working in the background', sentence: 'Its turn ended, but work the agent started is still running; it carries on when that finishes.' }
    : stateFactor(session, state);
  add(base.label, (BASE_SCORE[inBackground ? 'working' : state] ?? 0) + (state === 'snoozed' ? SNOOZED_PENALTY : 0));
  const extra: string[] = [];

  if (session.user.pinned) {
    add('Pinned', PINNED_BOOST);
    extra.push('it is pinned, so it stays above unpinned sessions');
  }
  if (session.user.priority) {
    add(`You set priority ${session.user.priority.toUpperCase()}`, PRIORITY_BOOST[session.user.priority]);
    extra.push(`you gave it priority ${session.user.priority.toUpperCase()}`);
  }

  if (state !== 'snoozed') {
    if (session.git && session.git.uncommittedFiles > 0) {
      add(`${plural(session.git.uncommittedFiles, 'uncommitted file')}`, 20);
    }
    if (session.git && session.git.unpushedCommits > 0) {
      add(`${plural(session.git.unpushedCommits, 'unpushed commit')}`, 5);
    }
    // Recency boost (+0 to +40 over the last 24h)
    const ageMs = Math.max(0, Date.now() - session.updatedAt);
    if (ageMs < DAY) {
      const recencyBoost = Math.round(40 * (1 - ageMs / DAY));
      if (recencyBoost > 0) add(`Active ${ago(ageMs)}`, recencyBoost);
    }
  }

  const score = factors.reduce((sum, f) => sum + f.points, 0);
  const lift = state === 'snoozed' ? 'Among snoozed sessions it ranks higher because' : 'It also ranks higher because';
  const summary = extra.length ? `${base.sentence} ${lift} ${extra.join(' and ')}.` : base.sentence;
  const reasons = factors.map((f) => `${f.label} (${f.points >= 0 ? '+' : ''}${f.points})`);
  return { score, state, factors, summary, reasons };
}

export function sortSessions(sessions: AcpSession[]): AcpSession[] {
  return [...sessions].sort((a, b) => {
    // Highest score first
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    // Tie-break by most recent activity
    return b.updatedAt - a.updatedAt;
  });
}
