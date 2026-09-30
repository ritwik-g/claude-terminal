export type SessionState =
  | 'blocked'    // waiting for permission or question approval (highest attention)
  | 'needs_you'  // turn finished, waiting for next prompt
  | 'working'    // agent processing, thinking, or running tool
  | 'parked'     // idle, but git repo has uncommitted/unpushed work
  | 'quiet'      // idle, git repo is completely clean
  | 'crashed'    // subprocess exited abnormally
  | 'snoozed';   // temporarily hidden until snooze timestamp

export interface SlashCommandItem {
  command: string;
  label: string;
  description: string;
  category: 'agent' | 'terminal';
  hint?: string;
  icon?: string;
  actionType?: 'insert' | 'immediate';
  agentIds?: string[];
}

export interface AgentDescriptor {
  id: string;
  name: string;
  provider: 'anthropic' | 'openai' | 'google' | 'custom' | 'mock';
  description: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  icon: string;
  defaultModel?: string;
  availableModels?: string[];
  slashCommands?: SlashCommandItem[];
  /** MCP transports the agent takes in `session/new`; empty when it can't take any. */
  mcpSupport?: { transports: McpTransport[]; note?: string };
  /** Effort levels to offer before the agent has reported its own; empty when it has no effort setting. */
  efforts?: ConfigChoice[];
  /** What the agent last advertised per model (from the options cache), keyed by model id. */
  advertised?: Record<string, AgentOptions>;
}

/** One value of an agent's select-style config option (ACP SessionConfigSelectOption). */
export interface ConfigChoice {
  value: string;
  label: string;
  description?: string;
}

/**
 * The effort and model choices a running agent advertised through ACP
 * `configOptions` (session/new, set_config_option, config_option_update).
 */
export interface AgentOptions {
  /** The config option id that carries effort ('effort' for Claude, 'reasoning_effort' for Codex). */
  effortConfigId?: string;
  /** Effort levels the current model accepts, without the agent's own "default" row. */
  efforts: ConfigChoice[];
  /** The agent's own "default" effort row, which 'auto' maps to. */
  effortDefaultValue?: string;
  /** The level the agent recommends, when it says (Codex does). */
  recommendedEffort?: string;
  currentEffort?: string;
  modelConfigId?: string;
  models: ConfigChoice[];
  currentModel?: string;
  updatedAt: number;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind?: 'allow_once' | 'allow_always' | 'deny' | string;
}

export interface PendingPermission {
  requestId: string;
  toolCallId: string;
  title: string;
  options: PermissionOption[];
  rawParams?: unknown;
  requestedAt: number;
}

export interface ToolCallRecord {
  id: string;
  title: string;
  kind?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  input?: unknown;
  output?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
  /** Agent-side tool name (e.g. Bash, Read, Agent), from _meta.claudeCode.toolName or ACP `name`. */
  toolName?: string;
  /** Human description of the call when the agent gives one (e.g. Bash `description`). */
  description?: string;
  /** Set on calls made by a subagent: the id of the tool call that spawned it. */
  parentToolUseId?: string;
  /** True when this call spawns a subagent (Claude's Agent/Task tool). */
  isSubagent?: boolean;
  subagentType?: string;
  /** Text the subagent streamed back, kept out of the main conversation. */
  subagentText?: string;
  /** Shell exit code, from ACP terminal_exit meta. */
  exitCode?: number | null;
  /** The command keeps running after the call returns (background shell, async agent). */
  background?: boolean;
  /** Lifecycle of that background work; absent means still running (or never reported). */
  backgroundState?: BackgroundState;
  /** How the background work ended, e.g. the agent's summary or why it was cut off. */
  backgroundSummary?: string;
  backgroundEndedAt?: number;
  /** Set on calls made inside a subagent or workflow: the id of that AgentTask. */
  agentTaskId?: string;
  /** What a finished subagent reported using (Claude's Agent tool response). */
  agentUsage?: AgentTask['usage'];
  /** An async subagent's transcript file (Claude's Agent tool response `outputFile`). */
  agentOutputFile?: string;
}

/**
 * The chronological parts of an agent turn. Agents interleave several messages
 * with tool calls in one turn; keeping the order lets the UI show them as
 * separate messages instead of one merged blob.
 */
export type TurnSegment =
  | { kind: 'text'; id: string; text: string; messageId?: string }
  | { kind: 'thought'; id: string; text: string }
  | { kind: 'tool'; id: string; toolCallId: string };

export interface PlanEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: 'high' | 'medium' | 'low';
}

export interface FileAttachment {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  path?: string;
  url?: string;
  data?: string;
  isImage?: boolean;
}

export interface TurnMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  content?: string;
  thoughts?: string;
  attachments?: FileAttachment[];
  toolCalls?: ToolCallRecord[];
  segments?: TurnSegment[];
  timestamp: number;
  agentId?: string;
  agentName?: string;
  model?: string;
  /** Set on the system turn that marks a context compaction; turns before it are what was compacted. */
  compaction?: CompactionRecord;
}

/**
 * A context compaction. 'native' runs the agent's own /compact in the same agent
 * session; 'handoff' asks the agent for a handoff summary, restarts it, and sends
 * the summary as the first context of the next prompt.
 */
export interface CompactionRecord {
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  method: 'native' | 'handoff';
  /** 'auto' is "Compact when finished"; 'agent' is the agent compacting on its own mid-turn. */
  trigger: 'manual' | 'auto' | 'agent';
  startedAt: number;
  endedAt?: number;
  /** Context tokens before and after, when known. */
  preTokens?: number;
  postTokens?: number;
  /** postTokens is a rough count of the handoff summary, not a figure the agent reported. */
  postTokensEstimated?: boolean;
  summary?: string;
  error?: string;
}

/** "Compact when finished": compact after a clean turn once context use passes the threshold. */
export interface AutoCompactSetting {
  enabled: boolean;
  /** Percent of the context window, e.g. 50. */
  thresholdPercent: number;
}

export interface GitInfo {
  branch: string;
  uncommittedFiles: number;
  unpushedCommits: number;
  isClean: boolean;
  repoRoot: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  contextTokens: number;
}

export interface UserAnnotations {
  priority: 'p0' | 'p1' | 'p2' | null;
  pinned: boolean;
  snoozedUntil: number | null;
  tags: string[];
  cleanup: boolean;
  note?: string;
  autoApprove?: boolean;
}

/**
 * 'auto' leaves the choice to the agent (the model's own default); any other value
 * is one the agent advertised for the current model, e.g. 'xhigh' or 'max'.
 */
export type ThinkingEffort = string;
export const AUTO_EFFORT = 'auto';
export type ContextTransferMode = 'compact' | 'full' | 'none';

export interface RateLimitWindow {
  utilization: number;
  resetsAt?: string | null;
}

export interface SessionRateLimits {
  fiveHour?: RateLimitWindow | null;
  weeklyAll?: RateLimitWindow | null;
  weeklyModels?: Array<{ name: string; utilization: number; resetsAt?: string | null }>;
  updatedAt?: number;
}

export interface AcpSession {
  id: string;
  agentId: string;
  agentName: string;
  title: string;
  titleSource: 'user' | 'agent' | 'auto';
  cwd: string;
  startedAt: number;
  updatedAt: number;
  state: SessionState;
  score: number;
  reasons: string[];
  /** The score's parts in plain language, and one sentence on why it sits where it does. */
  rankFactors?: Array<{ label: string; points: number }>;
  rankSummary?: string;
  lastPrompt: string;
  recap: string;
  usage: TokenUsage;
  git: GitInfo | null;
  user: UserAnnotations;
  pendingPermission: PendingPermission | null;
  turns: TurnMessage[];
  model?: string;
  effort?: ThinkingEffort;
  contextMode?: ContextTransferMode;
  contextHandoffPending?: boolean;
  failoverFromId?: string; // Tracks previous session if failed over from another agent
  activeTerminalId?: string;
  promptSuggestion?: string;
  rateLimits?: SessionRateLimits;
  isAgentRunning?: boolean;
  agentStopped?: boolean; // Set by an explicit Stop; ranks the session 'parked' until restarted
  /** The agent's latest todo list (ACP `plan` update). */
  plan?: PlanEntry[];
  /** App-level MCP servers handed to the agent when it last started. */
  mcp?: SessionMcpInfo;
  /** Messages sent while a turn was running; the next one goes out when a turn ends cleanly. */
  queuedPrompts?: QueuedPrompt[];
  /** Subagents, background tasks and workflows the agent launched, oldest first. */
  agentTasks?: AgentTask[];
  /** Effort and model choices the agent advertised when it last ran. */
  agentOptions?: AgentOptions;
  /** Context window the agent reported (ACP usage_update.size); the model table is only a fallback. */
  contextWindow?: number;
  /** "Compact when finished" for this session. */
  autoCompact?: AutoCompactSetting;
}

export interface QueuedPrompt {
  id: string;
  text: string;
  attachments?: FileAttachment[];
  queuedAt: number;
}

export interface SessionSummary {
  id: string;
  agentId: string;
  agentName: string;
  title: string;
  model?: string;
  effort?: ThinkingEffort;
  cwd: string;
  startedAt: number;
  updatedAt: number;
  state: SessionState;
  score: number;
  reasons: string[];
  /** The score's parts in plain language, and one sentence on why it sits where it does. */
  rankFactors?: Array<{ label: string; points: number }>;
  rankSummary?: string;
  lastPrompt: string;
  recap: string;
  git: GitInfo | null;
  user: UserAnnotations;
  hasPendingPermission: boolean;
  pendingPermissionTitle?: string;
  tokenCount: number;
  turnCount: number;
  isAgentRunning?: boolean;
  /** A compaction is running (started here or by the agent). */
  compacting?: boolean;
}

// ------------------------------------------------------------------ MCP

export type McpTransport = 'stdio' | 'http' | 'sse';

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  /** 'all', or the one agent id the server is limited to. */
  scope: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  presetId?: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

/** McpServerConfig as sent to the browser, with secret values masked. */
export type McpServerView = McpServerConfig;

export type McpServerInput = Partial<Omit<McpServerConfig, 'id' | 'createdAt' | 'updatedAt'>>;

export interface SessionMcpInfo {
  attached: string[];
  skipped: Array<{ name: string; reason: string }>;
}

export type BackgroundState = 'running' | 'completed' | 'failed' | 'stopped';

/** An AIR `async_task_*` session update (background shell, workflow, monitor). */
export interface AsyncTaskUpdate {
  kind: 'spawned' | 'progress' | 'state';
  asyncTaskId: string;
  toolCallId?: string;
  state?: BackgroundState;
  summary?: string;
  name?: string;
  /** File the agent writes the task's output to. */
  outputFilePath?: string;
  /** shell, workflow, monitor or task (spawned only). */
  taskType?: string;
  description?: string;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
}

// ------------------------------------------------------------ Agent tasks

export type AgentTaskKind = 'subagent' | 'background' | 'workflow';
export type AgentTaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

/**
 * Work the session's agent handed off: a subagent (Claude's Agent/Task tool),
 * a background shell or monitor, or a workflow run. The tool calls and
 * messages it produced are tagged with its id so it can be viewed on its own.
 */
export interface AgentTask {
  /** The spawning tool call's id, or `task:<asyncTaskId>` when there is none. */
  id: string;
  kind: AgentTaskKind;
  title: string;
  /** The task given to it: a subagent's prompt, a command, a workflow description. */
  prompt?: string;
  /** Subagent type (e.g. Explore), or the background task type (shell, monitor, workflow). */
  agentType?: string;
  status: AgentTaskStatus;
  startedAt: number;
  endedAt?: number;
  /** The tool call that launched it. */
  toolCallId?: string;
  /** The AIR async task id, for background work and workflows. */
  asyncTaskId?: string;
  /** The task it was launched from, when a subagent launches another. */
  parentTaskId?: string;
  /** How it ended, or why it was cut off. */
  summary?: string;
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
  /** Its own messages, reasoning and tool calls in the order they happened. */
  segments?: TurnSegment[];
}

/** One streamed chunk of a task's text or reasoning; the client appends it to the named segment. */
export interface AgentTaskTextDelta {
  taskId: string;
  segmentId: string;
  kind: 'text' | 'thought';
  messageId?: string;
  text: string;
  /** For a reply chunk: the spawning call, whose `subagentText` gets it too. */
  toolCallId?: string;
}
