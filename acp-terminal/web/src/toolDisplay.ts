import type { ToolCallRecord, TurnMessage, TurnSegment } from './types';
import type { IconName } from './components/Icons';

export interface ToolDescription {
  icon: IconName;
  /** Short verb phrase, e.g. "Read", "Ran", "Edited". */
  verb: string;
  /** The object of the verb: a command, a file name, a query. */
  target: string;
  /** Render the target in monospace (commands, paths). */
  mono: boolean;
}

const basename = (p: string) => p.split('/').filter(Boolean).pop() || p;

export function toolInput(call: ToolCallRecord): Record<string, any> {
  return call.input && typeof call.input === 'object' ? (call.input as Record<string, any>) : {};
}

export function commandOf(call: ToolCallRecord): string | undefined {
  const input = toolInput(call);
  if (typeof input.command === 'string') return input.command;
  if (call.title?.startsWith('$ ')) return call.title.slice(2);
  if (isShellCall(call) && call.title && call.title !== 'Terminal') return call.title;
  return undefined;
}

export function isShellCall(call: ToolCallRecord): boolean {
  return call.kind === 'execute' || call.toolName === 'Bash' || call.toolName === 'PowerShell' || typeof toolInput(call).command === 'string';
}

export function describeTool(call: ToolCallRecord): ToolDescription {
  const input = toolInput(call);
  const name = call.toolName || '';
  const path: string | undefined = input.file_path || input.path || input.notebook_path;

  if (call.isSubagent) {
    return { icon: 'bot', verb: 'Subagent', target: call.description || input.description || call.title, mono: false };
  }
  if (isShellCall(call)) {
    return { icon: 'terminal', verb: call.background ? 'Started' : 'Ran', target: commandOf(call) || call.title, mono: true };
  }
  if (call.kind === 'read' || name === 'Read' || name === 'NotebookRead') {
    return { icon: 'file', verb: 'Read', target: path ? basename(path) : call.title.replace(/^Read:?\s*/, ''), mono: true };
  }
  if (call.kind === 'edit' || call.kind === 'delete' || call.kind === 'move' || ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(name)) {
    const verb = name === 'Write' ? 'Wrote' : call.kind === 'delete' ? 'Deleted' : 'Edited';
    return { icon: 'fileEdit', verb, target: path ? basename(path) : call.title, mono: Boolean(path) };
  }
  if (call.kind === 'search' || name === 'Grep' || name === 'Glob' || name === 'ToolSearch') {
    const q = input.pattern || input.query;
    return { icon: 'search', verb: 'Searched', target: q ? String(q) : call.title, mono: Boolean(q) };
  }
  if (call.kind === 'fetch' || name === 'WebFetch' || name === 'WebSearch') {
    return { icon: 'globe', verb: name === 'WebSearch' ? 'Searched the web' : 'Fetched', target: input.url || input.query || call.title, mono: false };
  }
  if (call.kind === 'think') {
    return { icon: 'brain', verb: '', target: call.title, mono: false };
  }
  return { icon: 'tool', verb: '', target: call.title || name || 'Tool call', mono: false };
}

export function isActive(call: ToolCallRecord): boolean {
  return call.status === 'pending' || call.status === 'running';
}

export function durationLabel(call: ToolCallRecord): string | null {
  if (!call.completedAt || !call.startedAt) return null;
  const ms = call.completedAt - call.startedAt;
  if (ms < 1000) return null;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export type SubagentStatus = 'running' | 'background' | 'done' | 'failed';

/** A subagent launched asynchronously returns at once; its own calls show whether it is still going. */
export function subagentStatus(call: ToolCallRecord, children: ToolCallRecord[]): SubagentStatus {
  if (call.status === 'failed') return 'failed';
  if (isActive(call) || children.some(isActive)) return 'running';
  if (call.background && !call.subagentText) return 'background';
  return 'done';
}

const STAT_LINE = /^(agentId|agent_id|subagent_tokens|tool_uses|duration_ms):\s*(.*)$/;

/** Usage stats Claude Code appends to a subagent's report (tool uses, duration). */
export function subagentStats(call: ToolCallRecord): { toolUses?: number; durationMs?: number } {
  const stats: { toolUses?: number; durationMs?: number } = {};
  for (const line of (call.output || '').split('\n')) {
    const m = line.trim().match(STAT_LINE);
    if (m?.[1] === 'tool_uses') stats.toolUses = Number(m[2]);
    if (m?.[1] === 'duration_ms') stats.durationMs = Number(m[2]);
  }
  return stats;
}

/** Hides the adapter's internal bookkeeping text for async launches. */
export function subagentResult(call: ToolCallRecord): string | undefined {
  if (call.subagentText?.trim()) return call.subagentText;
  const out = call.output?.trim();
  if (!out || /^Async agent launched/i.test(out)) return undefined;
  // Claude Code wraps a subagent's report in a hand-back preamble and indents it.
  const marker = out.indexOf('The report follows:');
  if (out.startsWith('[Subagent hand-back]') && marker !== -1) {
    const lines = out.slice(marker + 'The report follows:'.length).split('\n');
    return stripStats(lines.map((l) => l.replace(/^ {2}/, '')).join('\n'));
  }
  return stripStats(out);
}

/** Turns without recorded segments (older sessions) get a reasonable order: thinking, tools, reply. */
export function segmentsOf(turn: TurnMessage): TurnSegment[] {
  if (turn.segments && turn.segments.length > 0) return turn.segments;
  const segs: TurnSegment[] = [];
  if (turn.thoughts?.trim()) segs.push({ kind: 'thought', id: `${turn.id}-thought`, text: turn.thoughts });
  for (const call of turn.toolCalls || []) {
    if (!call.parentToolUseId) segs.push({ kind: 'tool', id: `${turn.id}-${call.id}`, toolCallId: call.id });
  }
  if (turn.content?.trim()) segs.push({ kind: 'text', id: `${turn.id}-text`, text: turn.content });
  return segs;
}

function stripStats(text: string): string {
  return text
    .split('\n')
    .filter((l) => !STAT_LINE.test(l.trim()) && !/^<\/?usage>$/.test(l.trim()))
    .join('\n')
    .trim();
}
