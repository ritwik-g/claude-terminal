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

export type ThinkingEffort = 'off' | 'low' | 'medium' | 'high';
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
  lastPrompt: string;
  recap: string;
  git: GitInfo | null;
  user: UserAnnotations;
  hasPendingPermission: boolean;
  pendingPermissionTitle?: string;
  tokenCount: number;
  turnCount: number;
  isAgentRunning?: boolean;
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
