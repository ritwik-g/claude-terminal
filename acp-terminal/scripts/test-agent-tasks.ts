/**
 * Agent tasks (subagents, background shells, workflows): the records built on a
 * session from the agent's tool calls, AIR async_task updates and subagent
 * transcripts. Pure logic, no agent process.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AcpSession, ToolCallRecord, TurnMessage } from '../server/types.js';
import {
  appendSubagentText,
  completeAsyncSubagent,
  endAgentTasks,
  readTranscriptEnd,
  stopAgentTask,
  syncAgentTasks,
  trackAsyncTask,
  trackTaskText,
  trackToolCall,
  trackToolCallUpdate,
} from '../server/acp/agent-tasks.js';
import { parseAsyncTaskUpdate } from '../server/acp/client-host.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

function session(turns: TurnMessage[] = [], withTasks = true): AcpSession {
  return {
    id: 's1', agentId: 'claude', agentName: 'Claude', title: 't', titleSource: 'auto', cwd: '/tmp',
    startedAt: 0, updatedAt: 0, state: 'working', score: 0, reasons: [], lastPrompt: '', recap: '',
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, contextTokens: 0 }, git: null,
    user: { priority: null, pinned: false, snoozedUntil: null, tags: [], cleanup: false },
    pendingPermission: null, turns, ...(withTasks ? { agentTasks: [] } : {}),
  };
}

function agentTurn(calls: ToolCallRecord[] = []): TurnMessage {
  return { id: 'm1', role: 'agent', toolCalls: calls, segments: [], timestamp: 0 };
}

/** What session-mgr does with a new call: store it on the turn, then track it. */
function addCall(s: AcpSession, call: ToolCallRecord) {
  s.turns[0].toolCalls!.push(call);
  return trackToolCall(s, call);
}

function update(s: AcpSession, id: string, patch: Partial<ToolCallRecord>) {
  const call = s.turns[0].toolCalls!.find((c) => c.id === id)!;
  Object.assign(call, patch);
  return trackToolCallUpdate(s, call);
}

console.log('agent tasks');

test('a subagent call starts a task, fills in its title, and finishes with the call', () => {
  const s = session([agentTurn()]);
  const [task] = addCall(s, { id: 'a1', title: 'Task', status: 'pending', startedAt: 1000, isSubagent: true, toolName: 'Agent' });
  assert.equal(task.id, 'a1');
  assert.equal(task.kind, 'subagent');
  assert.equal(task.title, 'Subagent'); // placeholder until the input streams in
  update(s, 'a1', { input: { description: 'Count ts files', prompt: 'Count the .ts files', subagent_type: 'Explore' }, subagentType: 'Explore' });
  assert.equal(s.agentTasks![0].title, 'Count ts files');
  assert.equal(s.agentTasks![0].prompt, 'Count the .ts files');
  assert.equal(s.agentTasks![0].agentType, 'Explore');
  assert.equal(s.agentTasks![0].status, 'running');
  update(s, 'a1', { status: 'completed', completedAt: 5000, agentUsage: { totalTokens: 20817, toolUses: 1, durationMs: 4225 } });
  assert.equal(s.agentTasks![0].status, 'completed');
  assert.equal(s.agentTasks![0].endedAt, 5000);
  assert.deepEqual(s.agentTasks![0].usage, { totalTokens: 20817, toolUses: 1, durationMs: 4225 });
});

test("calls, text and reasoning inside a subagent are tagged with and filed under it", () => {
  const s = session([agentTurn()]);
  addCall(s, { id: 'a1', title: 'Explore', status: 'running', startedAt: 1, isSubagent: true });
  const changed = addCall(s, { id: 'b1', title: '$ ls', status: 'running', startedAt: 2, parentToolUseId: 'a1' });
  assert.equal(s.turns[0].toolCalls![1].agentTaskId, 'a1');
  assert.deepEqual(changed.map((t) => t.id), ['a1']);
  trackTaskText(s, 'a1', 'thought', 'Look');
  trackTaskText(s, 'a1', 'thought', 'ing');
  trackTaskText(s, 'a1', 'text', 'Found ', 'm1');
  trackTaskText(s, 'a1', 'text', '3.', 'm1');
  trackTaskText(s, 'a1', 'text', 'Next', 'm2');
  const segs = s.agentTasks![0].segments!;
  assert.deepEqual(segs.map((x) => x.kind), ['tool', 'thought', 'text', 'text']);
  assert.equal((segs[1] as any).text, 'Looking');
  assert.equal((segs[2] as any).text, 'Found 3.');
  // A call the task already has is not filed twice
  trackToolCall(s, s.turns[0].toolCalls![1]);
  assert.equal(s.agentTasks![0].segments!.filter((x) => x.kind === 'tool').length, 1);
  assert.equal(trackTaskText(s, 'unknown', 'text', 'x'), undefined);
});

test("the call's copy of a subagent reply is capped, keeping the end", () => {
  let text = '';
  for (let i = 0; i < 2000; i++) text = appendSubagentText(text, `chunk ${i} `.padEnd(40, '.'));
  assert.ok(text.length <= 32 * 1024, `capped at 32 KB, got ${text.length}`);
  assert.ok(text.startsWith('... [earlier text truncated] ...'));
  assert.ok(text.includes('chunk 1999'), 'the latest text is kept');
  assert.equal(appendSubagentText('Found ', '3.'), 'Found 3.');
});

test('a nested subagent records the task it was launched from', () => {
  const s = session([agentTurn()]);
  addCall(s, { id: 'a1', title: 'Outer', status: 'running', startedAt: 1, isSubagent: true });
  addCall(s, { id: 'a2', title: 'Inner', status: 'running', startedAt: 2, isSubagent: true, parentToolUseId: 'a1' });
  assert.equal(s.agentTasks![1].parentTaskId, 'a1');
});

test('a background shell is a task until its async task reports an end', () => {
  const s = session([agentTurn()]);
  addCall(s, { id: 'c1', title: '$ npm run dev', status: 'running', startedAt: 1, input: { command: 'npm run dev' } });
  assert.equal(s.agentTasks!.length, 0); // a foreground command is not a task
  update(s, 'c1', { status: 'completed', background: true, completedAt: 2 });
  assert.equal(s.agentTasks![0].kind, 'background');
  assert.equal(s.agentTasks![0].title, 'npm run dev');
  assert.equal(s.agentTasks![0].status, 'running');
  trackAsyncTask(s, { kind: 'spawned', asyncTaskId: 'bt1', toolCallId: 'c1', taskType: 'shell', name: 'Dev server' }, 'c1');
  assert.equal(s.agentTasks!.length, 1);
  assert.equal(s.agentTasks![0].asyncTaskId, 'bt1');
  assert.equal(s.agentTasks![0].agentType, 'shell');
  trackAsyncTask(s, { kind: 'state', asyncTaskId: 'bt1', state: 'failed', summary: 'exit 1' }, 'c1');
  assert.equal(s.agentTasks![0].status, 'failed');
  assert.equal(s.agentTasks![0].summary, 'exit 1');
});

test('a workflow is named after the run and takes its usage from progress', () => {
  const s = session([agentTurn()]);
  addCall(s, { id: 'w1', title: 'Workflow', status: 'completed', startedAt: 1, toolName: 'Workflow' });
  const task = trackAsyncTask(s, { kind: 'spawned', asyncTaskId: 'wt1', toolCallId: 'w1', taskType: 'workflow', name: 'review-pr', description: 'Review PR 42' }, 'w1')!;
  assert.equal(task.kind, 'workflow');
  assert.equal(task.title, 'review-pr');
  assert.equal(task.prompt, 'Review PR 42');
  trackAsyncTask(s, { kind: 'progress', asyncTaskId: 'wt1', usage: { totalTokens: 900, toolUses: 4, durationMs: 3000 } }, 'w1');
  assert.equal(task.usage!.toolUses, 4);
  // The completed Workflow call does not end the run; the async task does
  trackToolCallUpdate(s, s.turns[0].toolCalls![0]);
  assert.equal(task.status, 'running');
  trackAsyncTask(s, { kind: 'state', asyncTaskId: 'wt1', state: 'completed' }, 'w1');
  assert.equal(task.status, 'completed');
});

test('a spawn announced before its call is linked later without a duplicate record', () => {
  const s = session([agentTurn()]);
  // Seen live: async_task_spawned (no toolCallId), then the Bash call, then progress naming the call
  trackAsyncTask(s, { kind: 'spawned', asyncTaskId: 'bt1', taskType: 'shell', name: 'Run sleep in background' }, undefined);
  addCall(s, { id: 'c1', title: '$ sleep 20', status: 'completed', startedAt: 1, background: true, input: { command: 'sleep 20' } });
  assert.equal(s.agentTasks!.length, 2);
  trackAsyncTask(s, { kind: 'progress', asyncTaskId: 'bt1', toolCallId: 'c1' }, 'c1');
  assert.equal(s.agentTasks!.length, 1);
  const task = s.agentTasks![0];
  assert.equal(task.id, 'task:bt1');
  assert.equal(task.toolCallId, 'c1');
  assert.equal(task.prompt, 'sleep 20');
  assert.equal(task.startedAt, 1);
  // Later call updates land on the same record
  update(s, 'c1', { backgroundState: 'completed' });
  assert.equal(s.agentTasks!.length, 1);
  assert.equal(task.status, 'completed');
});

test('an async task with no tool call still gets a record; bare progress does not', () => {
  const s = session([agentTurn()]);
  assert.equal(trackAsyncTask(s, { kind: 'progress', asyncTaskId: 'x' }, undefined), undefined);
  const task = trackAsyncTask(s, { kind: 'spawned', asyncTaskId: 'm1', taskType: 'monitor', name: 'Watch logs' }, undefined)!;
  assert.equal(task.id, 'task:m1');
  assert.equal(task.title, 'Watch logs');
});

test('an async subagent runs until its transcript ends, then carries the report', () => {
  const s = session([agentTurn()]);
  addCall(s, { id: 'a1', title: 'Read notes', status: 'running', startedAt: 1, isSubagent: true });
  update(s, 'a1', { status: 'completed', background: true, output: 'Async agent launched', agentOutputFile: '/tmp/x.output' });
  assert.equal(s.agentTasks![0].status, 'running');
  const done = completeAsyncSubagent(s, 'a1', 'The file says hello')!;
  assert.equal(done.task.status, 'completed');
  assert.equal(done.call!.backgroundState, 'completed');
  assert.equal(done.call!.subagentText, 'The file says hello');
  assert.equal((s.agentTasks![0].segments!.at(-1) as any).text, 'The file says hello');
  assert.equal(completeAsyncSubagent(s, 'a1', 'again'), null);
});

test('stopping the agent stops running tasks and leaves finished ones', () => {
  const s = session([agentTurn()]);
  addCall(s, { id: 'a1', title: 'A', status: 'running', startedAt: 1, isSubagent: true });
  addCall(s, { id: 'a2', title: 'B', status: 'completed', startedAt: 1, completedAt: 2, isSubagent: true });
  assert.equal(endAgentTasks(s, 'Stopped when the agent was stopped'), true);
  assert.deepEqual(s.agentTasks!.map((t) => t.status), ['stopped', 'completed']);
  assert.equal(s.agentTasks![0].summary, 'Stopped when the agent was stopped');
  assert.equal(endAgentTasks(s, 'again'), false);
});

test('one task can be stopped on its own, only while it runs', () => {
  const s = session([agentTurn()]);
  addCall(s, { id: 'a1', title: 'A', status: 'running', startedAt: 1, isSubagent: true });
  addCall(s, { id: 'a2', title: 'B', status: 'running', startedAt: 1, isSubagent: true });
  const ended = stopAgentTask(s, 'a1', 'No sign of it finishing after 6 hours')!;
  assert.equal(ended.status, 'stopped');
  assert.equal(ended.summary, 'No sign of it finishing after 6 hours');
  assert.ok(ended.endedAt);
  assert.equal(s.agentTasks![1].status, 'running');
  assert.equal(stopAgentTask(s, 'a1', 'again'), null);
  assert.equal(stopAgentTask(s, 'missing', 'x'), null);
});

test('sessions recorded before tasks get them built; undone calls take their task along', () => {
  const calls: ToolCallRecord[] = [
    { id: 'a1', title: 'Map cookies', status: 'completed', startedAt: 1, completedAt: 9, isSubagent: true, subagentText: 'Found 4 reads' },
    { id: 'r1', title: 'Read: a.ts', status: 'completed', startedAt: 2, parentToolUseId: 'a1' },
    { id: 'x1', title: '$ ls', status: 'completed', startedAt: 3 },
  ];
  const s = session([agentTurn(calls)], false);
  assert.equal(syncAgentTasks(s), true);
  assert.equal(s.agentTasks!.length, 1);
  const task = s.agentTasks![0];
  assert.equal(task.status, 'completed');
  assert.equal(calls[1].agentTaskId, 'a1');
  assert.deepEqual(task.segments!.map((x) => x.kind), ['tool', 'text']);
  assert.equal(syncAgentTasks(s), false);
  s.turns = [];
  assert.equal(syncAgentTasks(s), true);
  assert.equal(s.agentTasks!.length, 0);
});

test('a transcript is done only when its last message ends the turn', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tasks-'));
  const file = path.join(dir, 'abc.output');
  const line = (o: unknown) => JSON.stringify(o) + '\n';
  fs.writeFileSync(file, line({ type: 'user', message: { role: 'user', content: 'go' } }) + line({ type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use' }] } }));
  assert.deepEqual(readTranscriptEnd(file), { done: false });
  fs.appendFileSync(file, line({ type: 'user', message: { content: [{ type: 'tool_result' }] } }));
  assert.deepEqual(readTranscriptEnd(file), { done: false });
  fs.appendFileSync(file, line({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'All done.' }] } }) + line({ type: 'summary' }));
  assert.deepEqual(readTranscriptEnd(file), { done: true, report: 'All done.' });
  // Only adapter task files are read
  const other = path.join(dir, 'abc.jsonl');
  fs.copyFileSync(file, other);
  assert.deepEqual(readTranscriptEnd(other), { done: false });
  assert.deepEqual(readTranscriptEnd('relative.output'), { done: false });
  assert.deepEqual(readTranscriptEnd(path.join(dir, 'missing.output')), { done: false });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('async_task updates carry type, description and usage', () => {
  const u = parseAsyncTaskUpdate({
    sessionUpdate: 'async_task_progress', asyncTaskId: 't1', description: 'Review',
    usage: { totalTokens: 5, toolUses: 2, durationMs: 100 },
  })!;
  assert.equal(u.kind, 'progress');
  assert.equal(u.description, 'Review');
  assert.deepEqual(u.usage, { totalTokens: 5, toolUses: 2, durationMs: 100 });
  const spawned = parseAsyncTaskUpdate({ sessionUpdate: 'async_task_spawned', asyncTaskId: 't2', taskType: 'workflow', name: 'wf', usage: { totalTokens: 1 } })!;
  assert.equal(spawned.taskType, 'workflow');
  assert.equal(spawned.usage, undefined);
});

test('a Workflow call is a workflow task, named from its script, even with no async_task update', () => {
  const s = session([agentTurn()]);
  const script = "export const meta = {\n  name: 'review-changes',\n  description: 'Review the diff, verify each finding',\n}\n";
  const [task] = addCall(s, { id: 'w1', title: 'Workflow', status: 'pending', startedAt: 1000, toolName: 'Workflow', background: true, input: JSON.stringify({ script }) });
  assert.equal(task.kind, 'workflow');
  assert.equal(task.title, 'review-changes');
  assert.equal(task.prompt, 'Review the diff, verify each finding');
  update(s, 'w1', { status: 'completed', completedAt: 2000 });
  assert.equal(s.agentTasks![0].status, 'running', 'the run outlives the launching call');
  update(s, 'w1', { backgroundState: 'completed', backgroundEndedAt: 9000 });
  assert.equal(s.agentTasks![0].status, 'completed');
  assert.equal(s.agentTasks![0].endedAt, 9000);
});

test('a workflow stored as a background task is relabelled when the session loads', () => {
  const call: ToolCallRecord = { id: 'w2', title: 'Workflow', status: 'completed', startedAt: 1000, toolName: 'Workflow', background: true, backgroundState: 'completed', input: { name: 'nightly-audit' } };
  const s = session([agentTurn([call])]);
  s.agentTasks = [{ id: 'w2', kind: 'background', title: 'Background task', status: 'completed', startedAt: 1000, toolCallId: 'w2' }];
  assert.equal(syncAgentTasks(s), true);
  assert.equal(s.agentTasks[0].kind, 'workflow');
  assert.equal(s.agentTasks[0].title, 'nightly-audit');
  assert.equal(syncAgentTasks(s), false, 'nothing left to change');
});

test("what the agent reports about a subagent (id, model, worktree) goes on the task's audit", () => {
  const s = session([agentTurn()]);
  addCall(s, { id: 'a9', title: 'Agent', status: 'pending', startedAt: 1, isSubagent: true, toolName: 'Agent' });
  s.agentTasks![0].audit = { agentId: 'claude', agentName: 'Claude Code', agentSessionId: 'sess-1' };
  update(s, 'a9', { status: 'completed', agentRef: { subagentId: 'abc123', subagentModel: 'claude-haiku-4-5', worktreeBranch: 'wt-1' } });
  const audit = s.agentTasks![0].audit!;
  assert.equal(audit.subagentId, 'abc123');
  assert.equal(audit.subagentModel, 'claude-haiku-4-5');
  assert.equal(audit.worktreeBranch, 'wt-1');
  assert.equal(audit.agentSessionId, 'sess-1', 'the session stamp is kept');
});

console.log(`\n${passed} passed`);
