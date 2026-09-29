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

export function deriveSessionState(session: Pick<AcpSession, 'pendingPermission' | 'turns' | 'git' | 'user' | 'state' | 'agentStopped'>): SessionState {
  // Check snooze first
  if (session.user?.snoozedUntil && session.user.snoozedUntil > Date.now()) {
    return 'snoozed';
  }

  // If there is an active permission or question request waiting for user response
  if (session.pendingPermission) {
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

export function rankSession(session: AcpSession): { score: number; reasons: string[]; state: SessionState } {
  const reasons: string[] = [];
  const state = deriveSessionState(session);

  let score = BASE_SCORE[state] ?? 0;
  reasons.push(`${state} base (${score >= 0 ? '+' : ''}${score})`);

  if (session.pendingPermission) {
    reasons.push(`blocked on approval: "${session.pendingPermission.title}"`);
  }

  // Priority boost
  if (session.user.priority) {
    const boost = PRIORITY_BOOST[session.user.priority];
    score += boost;
    reasons.push(`priority ${session.user.priority.toUpperCase()} (+${boost})`);
  }

  // Pinned boost
  if (session.user.pinned) {
    score += PINNED_BOOST;
    reasons.push(`pinned (+${PINNED_BOOST})`);
  }

  // Snoozed penalty
  if (state === 'snoozed') {
    score += SNOOZED_PENALTY;
    const remainingMin = Math.round(((session.user.snoozedUntil ?? 0) - Date.now()) / 60_000);
    reasons.push(`snoozed for another ${remainingMin}m (${SNOOZED_PENALTY})`);
    return { score, reasons, state };
  }

  // Git uncommitted files boost
  if (session.git && session.git.uncommittedFiles > 0) {
    score += 20;
    reasons.push(`uncommitted changes: ${session.git.uncommittedFiles} files (+20)`);
  }

  // Git unpushed commits boost
  if (session.git && session.git.unpushedCommits > 0) {
    score += 5;
    reasons.push(`unpushed commits: ${session.git.unpushedCommits} (+5)`);
  }

  // Recency boost (+0 to +40 based on last 24h activity)
  const ageMs = Math.max(0, Date.now() - session.updatedAt);
  if (ageMs < DAY) {
    const recencyBoost = Math.round(40 * (1 - ageMs / DAY));
    if (recencyBoost > 0) {
      score += recencyBoost;
      reasons.push(`recent activity (+${recencyBoost})`);
    }
  }

  return { score, reasons, state };
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
