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
