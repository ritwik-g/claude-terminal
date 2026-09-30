import fs from 'node:fs';
import path from 'node:path';
import type { AcpSession, AgentTask, AgentTaskStatus, AsyncTaskUpdate, ToolCallRecord, TurnSegment } from '../types.js';

/**
 * The session's agent tasks: subagents (Claude's Agent/Task tool), background
 * shells and monitors, and workflow runs. Each one gets a stable record on the
 * session, and the calls, messages and reasoning it produces are tagged with
 * its id so the UI can show one of them on its own.
 *
 * Everything here mutates the session in place and returns the tasks it
 * changed; the caller saves the session and broadcasts them.
 */

// Placeholder titles the adapter sends before a call's input has streamed in.
const PLACEHOLDER_TITLES = new Set(['Agent', 'Task', 'Tool Call', 'Terminal', 'Workflow']);

/** The session's tasks, built from its tool calls the first time for sessions recorded before tasks existed. */
function tasksOf(s: AcpSession): AgentTask[] {
  if (!s.agentTasks) {
    s.agentTasks = [];
    backfill(s);
  }
  return s.agentTasks;
}

/** The task launched by a tool call, if there is one. */
export function taskForToolCall(s: AcpSession, toolCallId: string): AgentTask | undefined {
  return tasksOf(s).find((t) => t.toolCallId === toolCallId || t.id === toolCallId);
}

/** A new tool call: start a task if it launches one, and file it under the task that made it. */
export function trackToolCall(s: AcpSession, call: ToolCallRecord): AgentTask[] {
  tasksOf(s);
  return trackCall(s, call);
}

function trackCall(s: AcpSession, call: ToolCallRecord): AgentTask[] {
  const changed = new Set<AgentTask>();
  if (call.parentToolUseId) {
    const owner = taskForToolCall(s, call.parentToolUseId);
    call.agentTaskId = owner?.id ?? call.parentToolUseId;
    if (owner && addSegment(owner, { kind: 'tool', id: `seg-${call.id}`, toolCallId: call.id })) changed.add(owner);
  }
  const task = upsertFromCall(s, call);
  if (task) changed.add(task);
  return [...changed];
}

/** A tool call changed: refresh the task it launched (title, prompt, status, usage). */
export function trackToolCallUpdate(s: AcpSession, call: ToolCallRecord): AgentTask[] {
  tasksOf(s);
  const task = upsertFromCall(s, call);
  return task ? [task] : [];
}

/** Text or reasoning a subagent streamed; goes to its own task, never the main transcript. */
export function trackTaskText(
  s: AcpSession,
  parentToolUseId: string,
  kind: 'text' | 'thought',
  text: string,
  messageId?: string
): AgentTask | undefined {
  const task = taskForToolCall(s, parentToolUseId);
  if (!task) return undefined;
  const segments = (task.segments ??= []);
  const last = segments[segments.length - 1];
  if (last && last.kind === kind && (kind === 'thought' || (last.kind === 'text' && (last.messageId ?? null) === (messageId ?? null)))) {
    last.text += text;
  } else {
    const id = `seg-${Date.now().toString(36)}-${segments.length}`;
    segments.push(kind === 'text' ? { kind, id, text, messageId } : { kind, id, text });
  }
  return task;
}

// The spawning call's copy of a subagent's reply is only its result preview (the task keeps
// the full text), so like tool output it is capped; the report is at the end, so keep the tail.
const SUBAGENT_TEXT_CAP = 32 * 1024;

export function appendSubagentText(existing: string | undefined, text: string): string {
  const all = (existing || '') + text;
  if (all.length <= SUBAGENT_TEXT_CAP) return all;
  return `... [earlier text truncated] ...\n${all.slice(-(SUBAGENT_TEXT_CAP - 64))}`;
}

/**
 * An AIR async_task_* update (background shell, monitor, workflow). `callId` is
 * the launching tool call when known; a task without one still gets a record.
 */
export function trackAsyncTask(s: AcpSession, u: AsyncTaskUpdate, callId: string | undefined): AgentTask | undefined {
  const tasks = tasksOf(s);
  let task = tasks.find((t) => t.asyncTaskId === u.asyncTaskId) ?? (callId ? taskForToolCall(s, callId) : undefined);
  const isWorkflow = u.taskType === 'workflow';
  if (!task) {
    // Progress for a task never announced (e.g. after a restart) carries too little to show
    if (u.kind !== 'spawned' && !callId) return undefined;
    const call = callId ? findCall(s, callId) : undefined;
    task = {
      id: callId ?? `task:${u.asyncTaskId}`,
      kind: isWorkflow ? 'workflow' : 'background',
      title: u.name || u.description || 'Background task',
      status: 'running',
      startedAt: call?.startedAt ?? Date.now(),
      toolCallId: callId,
      parentTaskId: call?.agentTaskId,
    };
    tasks.push(task);
  }
  task.asyncTaskId = u.asyncTaskId;
  if (callId && !task.toolCallId) {
    // The spawn can arrive before its call is known, and the call may have started a task of
    // its own meanwhile (a backgrounded shell): keep one record, the async task's
    const dup = tasks.find((t) => t !== task && (t.toolCallId === callId || t.id === callId));
    if (dup) {
      tasks.splice(tasks.indexOf(dup), 1);
      task.prompt ??= dup.prompt;
      task.startedAt = Math.min(task.startedAt, dup.startedAt);
      task.parentTaskId ??= dup.parentTaskId;
    }
    task.toolCallId = callId;
  }
  if (isWorkflow) task.kind = 'workflow';
  if (u.taskType && task.kind !== 'subagent') task.agentType = u.taskType;
  // A workflow's name beats the call's generic title; a shell keeps its command's description
  if (u.kind === 'spawned' && u.name && (task.kind === 'workflow' || !task.title || PLACEHOLDER_TITLES.has(task.title))) task.title = u.name;
  if (u.description && !task.prompt && task.kind === 'workflow') task.prompt = u.description;
  if (u.usage) task.usage = { ...task.usage, ...u.usage };
  if (u.state && u.state !== 'running') finish(task, u.state, u.summary);
  return task;
}

/** Mark one running task as stopped; null when it was not running. */
export function stopAgentTask(s: AcpSession, taskId: string, reason: string): AgentTask | null {
  const task = s.agentTasks?.find((t) => t.id === taskId);
  if (!task || task.status !== 'running') return null;
  finish(task, 'stopped', reason);
  return task;
}

/** Mark every task still running as stopped (the agent process is gone). */
export function endAgentTasks(s: AcpSession, reason: string): boolean {
  let changed = false;
  for (const task of s.agentTasks || []) {
    if (task.status === 'running') {
      finish(task, 'stopped', reason);
      changed = true;
    }
  }
  return changed;
}

/**
 * Keep the tasks consistent with the transcript: build them for sessions that
 * predate them, and drop tasks whose launching call was undone or compacted away.
 */
export function syncAgentTasks(s: AcpSession): boolean {
  if (!s.agentTasks) {
    tasksOf(s);
    return s.agentTasks!.length > 0;
  }
  const ids = new Set<string>();
  for (const turn of s.turns) for (const call of turn.toolCalls || []) ids.add(call.id);
  const kept = s.agentTasks.filter((t) => !t.toolCallId || ids.has(t.toolCallId));
  // Workflow runs recorded before they were recognised were filed as background tasks
  let relabelled = false;
  for (const task of kept) {
    const call = task.kind === 'background' && task.toolCallId ? findCall(s, task.toolCallId) : undefined;
    if (call && isWorkflowCall(call)) {
      refreshFromCall(task, call);
      relabelled = true;
    }
  }
  if (kept.length === s.agentTasks.length && !relabelled) return false;
  s.agentTasks = kept;
  return true;
}

/**
 * An async subagent finished (its transcript ended): record its report on the
 * task and on the launching call, which only ever said "launched".
 */
export function completeAsyncSubagent(s: AcpSession, taskId: string, report: string | undefined): { task: AgentTask; call?: ToolCallRecord } | null {
  const task = tasksOf(s).find((t) => t.id === taskId);
  if (!task || task.status !== 'running') return null;
  finish(task, 'completed');
  const call = task.toolCallId ? findCall(s, task.toolCallId) : undefined;
  if (call) {
    call.backgroundState = 'completed';
    call.backgroundEndedAt = task.endedAt;
    if (report && !call.subagentText?.trim()) call.subagentText = report;
  }
  if (report && !(task.segments || []).some((seg) => seg.kind === 'text')) {
    addSegment(task, { kind: 'text', id: `seg-${task.id}-report`, text: report });
  }
  return { task, call };
}

// ---------------------------------------------------------------------------

function upsertFromCall(s: AcpSession, call: ToolCallRecord): AgentTask | undefined {
  let task = taskForToolCall(s, call.id);
  if (!task) {
    // Only calls that hand work off get a task: subagents, workflows, and commands that went to the background
    if (!call.isSubagent && !call.background && !isWorkflowCall(call)) return undefined;
    task = {
      id: call.id,
      kind: call.isSubagent ? 'subagent' : isWorkflowCall(call) ? 'workflow' : 'background',
      title: '',
      status: 'running',
      startedAt: call.startedAt || Date.now(),
      toolCallId: call.id,
      parentTaskId: call.agentTaskId,
    };
    tasksOf(s).push(task);
  }
  refreshFromCall(task, call);
  return task;
}

function refreshFromCall(task: AgentTask, call: ToolCallRecord): void {
  const input = callInput(call);
  if (isWorkflowCall(call) && task.kind === 'background') task.kind = 'workflow';
  const title = [call.description, input.description, call.title].find(
    (v): v is string => typeof v === 'string' && v.trim() !== '' && !PLACEHOLDER_TITLES.has(v.trim())
  );
  if (task.kind === 'subagent') {
    if (title) task.title = title.trim();
    if (typeof input.prompt === 'string') task.prompt = input.prompt;
    task.agentType = call.subagentType || (typeof input.subagent_type === 'string' ? input.subagent_type : task.agentType);
    if (call.agentUsage) task.usage = { ...task.usage, ...call.agentUsage };
  } else if (task.kind === 'workflow') {
    // Its async task's name, when one is reported, beats the script's own name
    const meta = workflowMeta(input);
    if (meta.name && (!task.title || task.title === 'Background task' || PLACEHOLDER_TITLES.has(task.title))) task.title = meta.name;
    if (meta.description && !task.prompt) task.prompt = meta.description;
  } else {
    // A shell is known by its description or command
    const command = typeof input.command === 'string' ? input.command : undefined;
    const best = call.description || command || title;
    if (best) task.title = best.trim();
    if (command && !task.prompt) task.prompt = command;
  }
  if (!task.title) task.title = task.kind === 'subagent' ? 'Subagent' : task.kind === 'workflow' ? 'Workflow' : 'Background task';
  if (task.status !== 'running') return;
  const status = callStatus(task, call);
  if (status !== 'running') {
    finish(task, status, call.backgroundSummary, call.backgroundEndedAt ?? (call.background ? undefined : call.completedAt));
  }
}

/** Where the work a call launched stands. Background work outlives the call's own completion. */
function callStatus(task: AgentTask, call: ToolCallRecord): AgentTaskStatus {
  if (call.status === 'failed') return 'failed';
  if (call.backgroundState && call.backgroundState !== 'running') return call.backgroundState;
  if (call.status === 'pending' || call.status === 'running') return 'running';
  // Background work, an async subagent or a workflow run reports its end separately (async task, transcript)
  if (call.background || task.asyncTaskId || task.kind === 'workflow') return 'running';
  return 'completed';
}

function finish(task: AgentTask, status: AgentTaskStatus, summary?: string, at?: number): void {
  task.status = status;
  if (summary) task.summary = summary;
  if (status !== 'running' && !task.endedAt) task.endedAt = at ?? Date.now();
}

function addSegment(task: AgentTask, seg: TurnSegment): boolean {
  const segments = (task.segments ??= []);
  if (seg.kind === 'tool' && segments.some((x) => x.kind === 'tool' && x.toolCallId === seg.toolCallId)) return false;
  segments.push(seg);
  return true;
}

function isWorkflowCall(call: ToolCallRecord): boolean {
  return call.toolName === 'Workflow';
}

/** A call's input as an object; some adapters send it as a JSON string. */
function callInput(call: ToolCallRecord): Record<string, any> {
  let input: unknown = call.input;
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      return {};
    }
  }
  return input && typeof input === 'object' ? (input as Record<string, any>) : {};
}

/** A workflow's name and description: a saved workflow's name, or the `meta` block of an inline script. */
function workflowMeta(input: Record<string, any>): { name?: string; description?: string } {
  const script = typeof input.script === 'string' ? input.script : '';
  const field = (key: string) => script.match(new RegExp(`\\b${key}\\s*:\\s*(['"\`])((?:(?!\\1).)+)\\1`))?.[2];
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : field('name');
  return { name, description: field('description') };
}

function findCall(s: AcpSession, id: string): ToolCallRecord | undefined {
  for (let i = s.turns.length - 1; i >= 0; i--) {
    const call = s.turns[i].toolCalls?.find((c) => c.id === id);
    if (call) return call;
  }
  return undefined;
}

/** Rebuild tasks from the stored tool calls (sessions recorded before tasks existed). */
function backfill(s: AcpSession): void {
  for (const turn of s.turns) {
    for (const call of turn.toolCalls || []) trackCall(s, call);
  }
  for (const task of s.agentTasks!) {
    const call = task.toolCallId ? findCall(s, task.toolCallId) : undefined;
    if (task.kind === 'subagent' && call?.subagentText?.trim()) {
      addSegment(task, { kind: 'text', id: `seg-${task.id}-text`, text: call.subagentText });
    }
  }
}

// ---------------------------------------------------------------------------
// Async subagent transcripts
//
// Claude's adapter reports nothing when an async (background) subagent ends:
// its Agent call completes at launch with only a transcript path. The last
// assistant entry in that transcript ending the turn marks the subagent done.

const TRANSCRIPT_TAIL = 256 * 1024;
const WATCH_INTERVAL_MS = 2_000;
const WATCH_LIMIT_MS = 6 * 60 * 60 * 1000;
const watchers = new Map<string, NodeJS.Timeout>();

/** Whether a subagent transcript (JSONL) has ended, and the report it ended with. */
export function readTranscriptEnd(file: string): { done: boolean; report?: string } {
  // The adapter names these <tmp>/…/tasks/<agentId>.output (a link to the transcript); read nothing else
  if (!path.isAbsolute(file) || !file.endsWith('.output')) return { done: false };
  let text: string;
  try {
    const { size } = fs.statSync(file);
    const len = Math.min(size, TRANSCRIPT_TAIL);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { done: false };
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: any;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue; // blank, or the partial first line of the tail
    }
    if (entry?.type === 'user') return { done: false };
    if (entry?.type !== 'assistant') continue;
    const msg = entry.message;
    if (msg?.stop_reason !== 'end_turn' && msg?.stop_reason !== 'stop_sequence') return { done: false };
    const report = (Array.isArray(msg.content) ? msg.content : [])
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n')
      .trim();
    return { done: true, report: report || undefined };
  }
  return { done: false };
}

/**
 * Poll an async subagent's transcript until it ends, then call `onDone`.
 * Stops on its own once `stillRunning` says the task was settled some other way,
 * and calls `onGiveUp` if the transcript has not ended after WATCH_LIMIT_MS.
 */
export function watchSubagentTranscript(
  key: string,
  file: string,
  stillRunning: () => boolean,
  onDone: (report: string | undefined) => void,
  onGiveUp?: () => void
): void {
  if (watchers.has(key)) return;
  const started = Date.now();
  const timer = setInterval(() => {
    const running = stillRunning();
    if (!running || Date.now() - started > WATCH_LIMIT_MS) {
      clearInterval(timer);
      watchers.delete(key);
      if (running) onGiveUp?.();
      return;
    }
    const end = readTranscriptEnd(file);
    if (!end.done) return;
    clearInterval(timer);
    watchers.delete(key);
    onDone(end.report);
  }, WATCH_INTERVAL_MS);
  timer.unref();
  watchers.set(key, timer);
}

/** Stop watching every transcript of a session (it was deleted or its agent stopped). */
export function stopTranscriptWatchers(sessionId: string): void {
  for (const [key, timer] of watchers) {
    if (key.startsWith(`${sessionId}:`)) {
      clearInterval(timer);
      watchers.delete(key);
    }
  }
}
