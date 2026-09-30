export type SessionState =
  | 'blocked'
  | 'needs_you'
  | 'working'
  | 'parked'
  | 'quiet'
  | 'crashed'
  | 'snoozed';

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
  icon: string;
  defaultModel?: string;
  availableModels?: string[];
  slashCommands?: SlashCommandItem[];
  /** MCP transports the agent takes in `session/new`; empty when it can't take any. */
  mcpSupport?: { transports: McpTransport[]; note?: string };
  /** Effort levels to offer before the agent has reported its own; empty when it has no effort setting. */
  efforts?: ConfigChoice[];
  /** What the agent last advertised per model, keyed by model id. */
  advertised?: Record<string, AgentOptions>;
}

/** One value of an agent's select-style config option. */
export interface ConfigChoice {
  value: string;
  label: string;
  description?: string;
}

/** The effort and model choices a running agent advertised (ACP config options). */
export interface AgentOptions {
  effortConfigId?: string;
  /** Effort levels the current model accepts, without the agent's own "default" row. */
  efforts: ConfigChoice[];
  effortDefaultValue?: string;
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
  kind?: string;
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
  toolName?: string;
  description?: string;
  /** Set on calls made by a subagent: the id of the tool call that spawned it. */
  parentToolUseId?: string;
  isSubagent?: boolean;
  subagentType?: string;
  subagentText?: string;
  exitCode?: number | null;
  background?: boolean;
  /** Lifecycle of that background work; absent means still running (or never reported). */
  backgroundState?: 'running' | 'completed' | 'failed' | 'stopped';
  /** How the background work ended, e.g. the agent's summary or why it was cut off. */
  backgroundSummary?: string;
  backgroundEndedAt?: number;
  /** Set on calls made inside a subagent or workflow: the id of that AgentTask. */
  agentTaskId?: string;
}

/** Chronological parts of an agent turn (see server/types.ts). */
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
  /** Set on the system turn that marks a context compaction (see server/types.ts). */
  compaction?: CompactionRecord;
}

export interface CompactionRecord {
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  method: 'native' | 'handoff';
  trigger: 'manual' | 'auto' | 'agent';
  startedAt: number;
  endedAt?: number;
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

/** 'auto' (the agent's own default) or a level the agent advertised, e.g. 'xhigh'. */
export type ThinkingEffort = string;
export type ContextTransferMode = 'compact' | 'full' | 'none';

export interface QueuedPrompt {
  id: string;
  text: string;
  attachments?: FileAttachment[];
  queuedAt: number;
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
  failoverFromId?: string;
  activeTerminalId?: string;
  promptSuggestion?: string;
  rateLimits?: VendorRateLimits;
  isAgentRunning?: boolean;
  agentStopped?: boolean;
  /** The agent's latest todo list. */
  plan?: PlanEntry[];
  /** App-level MCP servers handed to the agent when it last started. */
  mcp?: SessionMcpInfo;
  /** Messages sent while a turn was running; the next one goes out when a turn ends cleanly. */
  queuedPrompts?: QueuedPrompt[];
  /** Subagents, background tasks and workflows the agent launched, oldest first. */
  agentTasks?: AgentTask[];
  /** Effort and model choices the agent advertised when it last ran. */
  agentOptions?: AgentOptions;
  /** Context window the agent reported; the model table is only a fallback. */
  contextWindow?: number;
  /** "Compact when finished" for this session. */
  autoCompact?: AutoCompactSetting;
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
}

export interface VendorRateLimitWindow {
  utilization: number;
  resetsAt?: string | null;
}

export interface VendorRateLimits {
  fiveHour?: VendorRateLimitWindow | null;
  weeklyAll?: VendorRateLimitWindow | null;
  weeklyModels?: Array<{ name: string; utilization: number; resetsAt?: string | null }>;
  /** Windows of any length (Codex reports e.g. a 30-day window); resetsAtMs is an epoch time. */
  windows?: Array<{ name: string; utilization: number; resetsAtMs?: number }>;
  /** Codex credit balance: 'None', 'Unlimited' or the balance. */
  credits?: string;
  planType?: string;
  updatedAt?: number;
}

export interface VendorSubscriptionInfo {
  vendorId: 'anthropic' | 'openai' | 'google';
  vendorName: string;
  authMode: 'subscription' | 'api_key' | 'desktop';
  accountEmail?: string;
  accountName?: string;
  planName: string;
  organization?: string;
  status: 'active' | 'configured' | 'unconfigured' | 'expired';
  apiKeyConfigured: boolean;
  apiKeyMasked?: string;
  reauthCommand?: string;
  details: Record<string, any>;
  rateLimits?: VendorRateLimits;
}

export interface StoredCredentials {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  geminiApiKey?: string;
  preferredAuthMode?: {
    anthropic?: 'subscription' | 'api_key';
    openai?: 'subscription' | 'api_key';
    google?: 'desktop' | 'api_key';
  };
}

export interface VendorUsageSummary {
  vendorId: 'anthropic' | 'openai' | 'google';
  vendorName: string;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  estimatedCost: number;
}

export interface UsageReport {
  overall: {
    totalSessions: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    estimatedCost: number;
  };
  vendors: Record<'anthropic' | 'openai' | 'google', VendorUsageSummary>;
  sessionsUsage: Array<{
    id: string;
    title: string;
    agentId: string;
    model?: string;
    totalTokens: number;
    contextTokens: number;
    contextLimit: number;
    percentContextUsed: number;
    estimatedCost: number;
  }>;
}

export interface SessionCostDetail {
  inputCost: number;
  outputCost: number;
  cachedCost: number;
  totalCost: number;
  pricing: {
    inputPerMillion: number;
    outputPerMillion: number;
    cachePerMillion: number;
    contextWindow: number;
  };
}


// ------------------------------------------------------------------ MCP

export type McpTransport = 'stdio' | 'http' | 'sse';

/** A configured MCP server as the API returns it: secret values arrive as MCP_MASK. */
export interface McpServer {
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

export type McpServerInput = Omit<McpServer, 'id' | 'createdAt' | 'updatedAt'>;

/** Placeholder the API sends instead of a secret; sending it back keeps the saved value. */
export const MCP_MASK = '••••••••';
export const WORKSPACE_VAR = '${workspace}';

export interface McpPreset {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  inputs?: Array<{ key: string; label: string; placeholder?: string; hint?: string; secret?: boolean; defaultValue?: string }>;
  requires?: string;
  available: boolean;
  docsUrl: string;
}

export interface McpProbeResult {
  ok: boolean;
  server?: { name?: string; version?: string };
  tools?: Array<{ name: string; description?: string }>;
  error?: string;
  durationMs: number;
}

export interface SessionMcpInfo {
  attached: string[];
  skipped: Array<{ name: string; reason: string }>;
}

export interface EcosystemReport {
  agentId: 'claude' | 'codex' | 'antigravity';
  name: string;
  detected: boolean;
  configPath: string;
  plugins: Array<{ name: string; source?: string; version?: string; enabled: boolean | null; description?: string }>;
  skills: Array<{ name: string; description?: string; origin: 'user' | 'plugin' | 'built-in'; plugin?: string }>;
  mcpServers: Array<{ name: string; transport?: string; enabled?: boolean }>;
  manageHint: string;
  warnings: string[];
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
