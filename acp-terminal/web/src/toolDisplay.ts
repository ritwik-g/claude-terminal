import type { AcpSession, ToolCallRecord, TurnMessage, TurnSegment } from './types';
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

// Past-tense verbs as they read while the call is waiting (e.g. on an
// approval) or still going: "Run git status" before it has run, "Running" during.
const VERB_TENSE: Record<string, { pending: string; running: string }> = {
  Ran: { pending: 'Run', running: 'Running' },
  Started: { pending: 'Start', running: 'Starting' },
  Read: { pending: 'Read', running: 'Reading' },
  Edited: { pending: 'Edit', running: 'Editing' },
  Wrote: { pending: 'Write', running: 'Writing' },
  Deleted: { pending: 'Delete', running: 'Deleting' },
  Searched: { pending: 'Search', running: 'Searching' },
  'Searched the web': { pending: 'Search the web', running: 'Searching the web' },
  Fetched: { pending: 'Fetch', running: 'Fetching' },
  Asked: { pending: 'Asking', running: 'Asking' },
};

/** `interrupted`: the call was cut off, so it reads as never having run ("Run", not "Running"). */
export function describeTool(call: ToolCallRecord, interrupted = false): ToolDescription {
  const d = describeToolDone(call);
  const tense = VERB_TENSE[d.verb];
  if (tense && (call.status === 'pending' || (interrupted && call.status === 'running'))) return { ...d, verb: tense.pending };
  if (tense && call.status === 'running') return { ...d, verb: tense.running };
  return d;
}

function describeToolDone(call: ToolCallRecord): ToolDescription {
  const input = toolInput(call);
  const name = call.toolName || '';
  const path: string | undefined = input.file_path || input.path || input.notebook_path;

  // A question for the user: Claude's AskUserQuestion, or a form card of its own
  if (call.elicitation || name === 'AskUserQuestion') {
    return { icon: 'help', verb: 'Asked', target: call.elicitation?.message || call.title, mono: false };
  }
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

/** Background work (a background shell, an async subagent) that has not reported an end. */
export function backgroundRunning(call: ToolCallRecord): boolean {
  return Boolean(call.background) && (call.backgroundState ?? 'running') === 'running';
}

/**
 * Tool calls that can still be going: every call in the newest turn while the
 * session is working (or waiting on an approval), plus background work from
 * any turn. A call marked pending or running anywhere else was cut off (the
 * agent stopped, or the server restarted mid-call) and never will finish.
 */
export function liveCallIds(session: AcpSession): Set<string> {
  const ids = new Set<string>();
  const busy = session.state === 'working' || Boolean(session.pendingPermission || session.pendingElicitation);
  const last = session.turns[session.turns.length - 1];
  for (const t of session.turns) {
    for (const c of t.toolCalls || []) {
      if (isActive(c) && (backgroundRunning(c) || (busy && t === last))) ids.add(c.id);
    }
  }
  return ids;
}

/** Failed outright, or a command that exited non-zero. */
export function isFailed(call: ToolCallRecord): boolean {
  return call.status === 'failed' || (call.exitCode != null && call.exitCode !== 0);
}

export function durationLabel(call: ToolCallRecord): string | null {
  if (!call.completedAt || !call.startedAt) return null;
  return formatDuration(call.completedAt - call.startedAt);
}

/** "4s", "2m 5s"; null under a second, where a duration is just noise. */
export function formatDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 1000) return null;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export type ToolCategory = 'command' | 'read' | 'edit' | 'search' | 'fetch' | 'other';

/** Coarse grouping used by the activity summary ("2 commands, 3 reads"). */
export function toolCategory(call: ToolCallRecord): ToolCategory {
  switch (describeTool(call).icon) {
    case 'terminal':
      return 'command';
    case 'file':
      return 'read';
    case 'fileEdit':
      return 'edit';
    case 'search':
      return 'search';
    case 'globe':
      return 'fetch';
    default:
      return 'other';
  }
}

const CATEGORY_NOUN: Record<ToolCategory, [string, string]> = {
  command: ['command', 'commands'],
  read: ['read', 'reads'],
  edit: ['edit', 'edits'],
  search: ['search', 'searches'],
  fetch: ['fetch', 'fetches'],
  other: ['tool call', 'tool calls'],
};

/** "5 steps · 2 commands, 3 reads · 1 failed" for a run of tool calls and reasoning. */
export function summarizeActivity(tools: ToolCallRecord[], thoughts: number): string {
  const counts = new Map<ToolCategory, number>();
  for (const t of tools) {
    const c = toolCategory(t);
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  const parts = [...counts.entries()].map(([c, n]) => `${n} ${CATEGORY_NOUN[c][n === 1 ? 0 : 1]}`);
  if (thoughts) parts.push(`${thoughts} thought${thoughts === 1 ? '' : 's'}`);
  const steps = tools.length + thoughts;
  const failed = tools.filter(isFailed).length;
  return [`${steps} step${steps === 1 ? '' : 's'}`, parts.join(', '), failed ? `${failed} failed` : '']
    .filter(Boolean)
    .join(' · ');
}

export interface DiffLine {
  type: 'add' | 'del' | 'context';
  text: string;
}

export interface DiffHunk {
  lines: DiffLine[];
}

/**
 * Edit-like calls whose input carries the text itself (Edit's old_string /
 * new_string, MultiEdit's edits, Write's content) render as red and green
 * lines. Returns null when there's nothing to diff.
 */
export function editDiff(call: ToolCallRecord): { path?: string; hunks: DiffHunk[] } | null {
  const input = toolInput(call);
  const path: string | undefined = input.file_path || input.path || input.notebook_path;
  const pairs: Array<{ old: string; next: string }> = [];
  if (typeof input.old_string === 'string' || typeof input.new_string === 'string') {
    pairs.push({ old: String(input.old_string ?? ''), next: String(input.new_string ?? '') });
  } else if (Array.isArray(input.edits)) {
    for (const e of input.edits) {
      if (e && (typeof e.old_string === 'string' || typeof e.new_string === 'string')) {
        pairs.push({ old: String(e.old_string ?? ''), next: String(e.new_string ?? '') });
      }
    }
  } else if (typeof input.content === 'string' && (call.toolName === 'Write' || call.kind === 'edit')) {
    pairs.push({ old: '', next: input.content });
  }
  if (pairs.length === 0) return null;
  return { path, hunks: pairs.map((p) => ({ lines: diffLines(p.old, p.next) })) };
}

/** Line diff that keeps a shared prefix and suffix as context and marks the middle as removed/added. */
function diffLines(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return [
    ...a.slice(0, start).map((text) => ({ type: 'context' as const, text })),
    ...a.slice(start, endA).map((text) => ({ type: 'del' as const, text })),
    ...b.slice(start, endB).map((text) => ({ type: 'add' as const, text })),
    ...a.slice(endA).map((text) => ({ type: 'context' as const, text })),
  ];
}

export type SubagentStatus = 'running' | 'background' | 'done' | 'failed' | 'stopped';

/** A subagent launched asynchronously returns at once; its own calls show whether it is still going. */
export function subagentStatus(call: ToolCallRecord, children: ToolCallRecord[]): SubagentStatus {
  if (call.status === 'failed') return 'failed';
  if (isActive(call) || children.some(isActive)) return 'running';
  if (call.backgroundState === 'failed') return 'failed';
  if (call.backgroundState === 'stopped') return 'stopped';
  if (backgroundRunning(call) && !call.subagentText) return 'background';
  return 'done';
}

// Trailing bookkeeping lines, possibly wrapped in <usage>…</usage>.
const STAT_LINE = /^(?:<\/?usage>)?\s*(agentId|agent_id|subagent_tokens|tool_uses|duration_ms):\s*(.*?)\s*(?:<\/usage>)?$/;

/** Usage stats Claude Code appends to a subagent's report (tool uses, duration). */
export function subagentStats(call: ToolCallRecord): { toolUses?: number; durationMs?: number } {
  const stats: { toolUses?: number; durationMs?: number } = {};
  for (const line of (call.output || '').split('\n')) {
    const m = line.trim().match(STAT_LINE);
    const n = m ? parseInt(m[2], 10) : NaN;
    if (Number.isNaN(n)) continue;
    if (m![1] === 'tool_uses') stats.toolUses = n;
    if (m![1] === 'duration_ms') stats.durationMs = n;
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

/** Copies text, falling back to a hidden textarea where the async API is unavailable (plain http on a LAN IP). */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }
}
