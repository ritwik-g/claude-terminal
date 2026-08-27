export type SessionState =
  | 'needs_you'   // Claude finished its turn and is waiting on you
  | 'working'     // actively running right now
  | 'crashed'     // process gone, but it died mid tool-call
  | 'parked'      // idle with work left behind (uncommitted changes / open PR)
  | 'quiet';      // nothing pending

export type Priority = 'p0' | 'p1' | 'p2';

/**
 * What KIND of session this is, derived from its span and size.
 * 'errand'  short, single-purpose  — a PR review, a quick question
 * 'task'    a normal piece of work
 * 'thread'  a long-running exploration carried across days
 */
export type SessionShape = 'errand' | 'task' | 'thread';

export interface LiveInfo {
  pid: number;
  status: 'busy' | 'idle';
  name: string;
  statusUpdatedAt: number;
  startedAt: number;
  socketPath?: string;
}

export interface PrLink {
  number: number;
  url: string;
  repository: string;
}

export interface TailInfo {
  /** stop_reason of the last assistant turn: 'end_turn' | 'tool_use' | ... */
  lastStopReason: string | null;
  /** role of the last substantive entry */
  lastRole: 'assistant' | 'user' | null;
  /** last user entry was a tool_result rather than something you typed */
  lastUserWasToolResult: boolean;
  /** ended while a tool call was still outstanding */
  endedMidTool: boolean;
}

export interface GitInfo {
  branch: string;
  dirty: number;
  ahead: number;
  behind: number;
  isWorktree: boolean;
  exists: boolean;
}

/** The bits a human owns. Everything else is derived. */
export interface UserState {
  tags: string[];
  priority: Priority | null;
  pinned: boolean;
  snoozedUntil: number | null;
  note: string;
  archived: boolean;
}

export interface Session {
  id: string;
  file: string;
  projectKey: string;
  cwd: string;
  branch: string;
  title: string;
  titleSource: string;
  lastPrompt: string;
  recap: string;
  pr: PrLink | null;
  startedAt: number;
  lastActivity: number;
  sizeBytes: number;
  messages: number;
  version: string;
  tail: TailInfo;
  live: LiveInfo | null;
  git: GitInfo | null;
  user: UserState;
  shape: SessionShape;
  state: SessionState;
  score: number;
  reasons: string[];
  /** a terminal is attached / running for this session */
  attached: boolean;
  /**
   * The id of that terminal. Equals `id` when resuming, but a session started
   * fresh runs under a generated 'new-…' id and only learns its session id
   * later — so the client must not assume the two are the same.
   */
  termId: string | null;
}

/**
 * A terminal that was open, recorded so a quit does not cost you your working
 * set. `cwd` is informational — restoring uses the session's own current cwd —
 * but it makes state.json legible when something has gone wrong.
 */
export interface WorkingSetEntry {
  sessionId: string;
  cwd: string;
}

/** A working-set entry we have checked is still restorable, ready to offer. */
export interface RestoreCandidate {
  sessionId: string;
  cwd: string;
  title: string;
}

export const EMPTY_USER_STATE: UserState = {
  tags: [],
  priority: null,
  pinned: false,
  snoozedUntil: null,
  note: '',
  archived: false,
};
