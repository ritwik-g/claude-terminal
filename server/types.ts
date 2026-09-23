export type SessionState =
  | 'blocked'     // stopped ON a question and cannot proceed until you answer
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
 * 'review'  opened to review code — derived from the command, not the span,
 *           so it OVERRIDES the others: what the session is for is more useful
 *           to filter on than how long it happened to run.
 */
export type SessionShape = 'errand' | 'task' | 'thread' | 'review';

export interface LiveInfo {
  pid: number;
  /**
   * Claude Code's own word for what the process is doing. 'waiting' is a THIRD
   * state, not a flavour of idle: idle means the turn ended and the prompt is
   * yours, waiting means Claude is stopped on a dialog and cannot continue at
   * all. 'unknown' is a registry entry with no status yet — a session that has
   * only just launched — which must not be read as either.
   *
   * 'shell' is idle with a background shell still running: the turn has ended
   * and the prompt is yours, but a `run_in_background` command (a dev server, a
   * watcher) is alive. Observed on 2.1.280 by sampling a session's own registry
   * file every 3s — `busy` while the turn ran, `shell` from the moment it
   * ended until the shell exited. It is a flavour of idle, NOT of busy.
   */
  status: 'busy' | 'idle' | 'shell' | 'waiting' | 'unknown';
  /**
   * Why it is waiting, verbatim from the registry: 'permission prompt' (the
   * default for any dialog kind Claude Code does not label), 'dialog open',
   * 'input needed', 'sandbox request', 'goal proposal'. Only ever a hint —
   * the labels are coarse and an AskUserQuestion reports the default.
   */
  waitingFor?: string;
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

/**
 * An artifact this session published, from a `frame-link` transcript record.
 * `url` is the identity: republishing writes another record at the same URL,
 * so repeats collapse into one entry with a bumped `revisions`.
 */
export interface Artifact {
  url: string;
  title: string;
  /** Local file the page was published from; informational, may be absent. */
  path: string;
  createdAt: number;
  updatedAt: number;
  /** How many publishes landed on this URL. 1 means never updated. */
  revisions: number;
}

/**
 * This session is reviewing someone's code, inferred from the slash command it
 * opened with. Purely derived — it is NOT written into UserState, because that
 * holds the things a human owns and an auto-applied tag there could not be
 * removed: the next scan would put it straight back.
 */
export interface ReviewInfo {
  /** The command as invoked, e.g. 'pr-review', minus its leading slash. */
  command: string;
  /**
   * The PR under review. `prs[0]` when there is one — kept as its own field
   * because most reviews have exactly one and every reader wants it directly.
   */
  pr: PrLink | null;
  /**
   * Every PR this review covers, deduped and in the order they appeared. A
   * review that compares two PRs, or works through a stack of them, is a
   * normal thing to do and showing only the first hid the rest.
   */
  prs: PrLink[];
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
  /**
   * Names of the tool calls left outstanding by that last turn. Empty unless
   * `endedMidTool`. This is how a dead session that stopped ON a question is
   * told apart from one that stopped mid-Bash: same dangling tool_use, very
   * different thing to do about it.
   */
  pendingTools: string[];
  /** The first question of a pending AskUserQuestion, so the row can say what was asked. */
  pendingQuestion: string | null;
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
  /**
   * Marked as cleaned up and ready to be closed and archived.
   *
   * Set by hand and never derived, unlike `ReviewInfo`. A review announces
   * itself — it opens with a command whose name says so — but the tidying-up
   * pass someone runs before shutting a session down is whatever they happen
   * to type that day, so there is no command name or phrase to match on and a
   * guess would be wrong in both directions: silence on the sessions that were
   * cleaned, a marker on the ones that were not.
   *
   * It is not a tag, because it is not a category: it is a step in getting rid
   * of the session, it applies to at most a handful at a time, and it is meant
   * to be cleared. Tags are the long-lived filing system, and burying this
   * among a dozen customer names is exactly how it goes unnoticed.
   */
  cleanup: boolean;
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
  /** Set when this session was opened to review code. Derived, never stored. */
  review: ReviewInfo | null;
  startedAt: number;
  lastActivity: number;
  sizeBytes: number;
  messages: number;
  /**
   * Tokens the last assistant turn carried — the session's live context size.
   * See ScannedSession.contextTokens for why this and not `sizeBytes`.
   */
  contextTokens: number;
  /** Last main-thread API call, epoch ms; 0 when none. See ScannedSession.lastApiAt. */
  lastApiAt: number;
  /** How long the prompt cache lives from `lastApiAt`. See ScannedSession.cacheTtlMs. */
  cacheTtlMs: number;
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
  /** Keep-warm for this session, when it is on or has just stopped. See keepwarm.ts. */
  keepWarm: KeepWarmView | null;
}

/**
 * Why a keep-warm ping that is due has not been sent. Each is a reason NOT to
 * type into the session, and none of them turns keep-warm off: the ping goes
 * as soon as the reason clears.
 *   'busy'      Claude Code reports a turn in progress — maybe a long tool
 *               call, maybe a stuck status. The app cannot tell which, so
 *               only you can override it, with Ping anyway.
 *   'unknown'   the session has not reported a status yet
 *   'no-status' no registry entry for the process at all
 *   'waiting'   stopped on a dialog; typing would answer it
 *   'question'  the transcript ends on an unanswered question or plan
 *   'usage'     the 5-hour window is past the pause threshold
 *   'no-turn'   no assistant turn found to time the ping from
 */
export type KeepWarmHold =
  | 'busy' | 'unknown' | 'no-status' | 'waiting' | 'question' | 'usage' | 'no-turn';

/**
 * Why keep-warm turned itself off.
 *   'typed'           you typed in the terminal and did not send it, so the
 *                     input box may hold a draft the ping would be appended to
 *   'cache-miss'      pings sent inside the cache lifetime missed anyway, so
 *                     the cache is not behaving the way this relies on
 *   'terminal-closed' no running terminal of ours serves the session any more —
 *                     closed, or moved on to a new session id by /branch
 *   'no-reply'        a ping produced no turn, so its text may be sitting in
 *                     the input box; another would pile on top of it
 *   'expired'         the duration you picked ran out
 *   'sent'            you sent a message, and it was set to stop when you did
 */
/**
 * Starts every keep-warm ping. Here rather than in keepwarm.ts so the scanner
 * can recognise a ping without importing the engine, and the PTY layer with it.
 */
export const KEEPWARM_MARKER = '[keep-warm]';

export type KeepWarmStop = 'typed' | 'cache-miss' | 'terminal-closed' | 'no-reply' | 'expired' | 'sent' | 'snoozed';

export interface KeepWarmView {
  /** False once it has stopped; `stopped` then says why. */
  active: boolean;
  enabledAt: number;
  /** Hard end, epoch ms. Always set — keep-warm never runs open-ended. */
  until: number;
  /** Also stop the moment you send a message of your own. */
  untilSend: boolean;
  /** Pause pings while the 5-hour window is at or above this percent. */
  pausePct: number | null;
  pings: number;
  lastPingAt: number | null;
  /** A ping is out and its reply has not landed yet. */
  awaitingReply: boolean;
  /** When the next ping is due, from the last API call. Null when unknown. */
  nextPingAt: number | null;
  /**
   * How the last ping's reply read the cache. 'cold' is a miss that was
   * expected — the cache had already expired before the ping went — so it
   * rebuilt the cache rather than finding it, and does not count against it.
   */
  lastResult: 'hit' | 'miss' | 'cold' | null;
  held: KeepWarmHold | null;
  heldSince: number | null;
  /**
   * You have typed since your last message, as of this moment. Not yet a
   * problem — send it and it is gone — but if it is still true when the next
   * ping is due, keep-warm turns off instead of pinging.
   */
  unsentSince: number | null;
  stopped: { reason: KeepWarmStop; at: number } | null;
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

/**
 * A session that stopped working, noticed by completions.ts.
 *
 * `kind` is what it stopped INTO, and the three are worth telling apart — they
 * ask different things of you:
 *   'idle'    the turn ended; the prompt is yours whenever you want it
 *   'waiting' it is stopped ON a dialog and cannot move until you answer
 *   'exited'  the process is gone; whether that was clean or a crash needs the
 *             transcript, which this path deliberately does not read
 *
 * `at` is when it stopped, not when the event fired — those differ by the hold
 * window — so a marker keyed on it survives the debounce without shifting.
 */
export interface CompletionEvent {
  sessionId: string;
  at: number;
  kind: 'idle' | 'waiting' | 'exited';
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
  cleanup: false,
};
