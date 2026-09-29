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
  failoverFromId?: string;
  activeTerminalId?: string;
  promptSuggestion?: string;
  rateLimits?: VendorRateLimits;
  isAgentRunning?: boolean;
  agentStopped?: boolean;
  /** The agent's latest todo list. */
  plan?: PlanEntry[];
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

export interface VendorRateLimitWindow {
  utilization: number;
  resetsAt?: string | null;
}

export interface VendorRateLimits {
  fiveHour?: VendorRateLimitWindow | null;
  weeklyAll?: VendorRateLimitWindow | null;
  weeklyModels?: Array<{ name: string; utilization: number; resetsAt?: string | null }>;
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

