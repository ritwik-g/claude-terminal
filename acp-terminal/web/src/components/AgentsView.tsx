import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AcpSession, AgentTask, AgentTaskStatus, ToolCallRecord, TurnSegment } from '../types';
import { Badge, Button, EmptyState, Icon, IconButton, Spinner, type IconName, type Tone } from '../ui';
import { MarkdownContent } from './MarkdownContent';
import { IoPanel, OutputText, SubagentCard, ThoughtRow, ToolRow } from './AgentTurn';
import { cx, formatTime, formatTokens } from './sessionMeta';
import { copyToClipboard, formatDuration, isActive, subagentResult } from '../toolDisplay';
import { VendorIcon } from './VendorLogos';
import { useOpenAgentSession } from './agentTaskNav';
import '../styles/agents.css';

/**
 * The session's Subagents tab: every subagent, background command and workflow
 * the agent launched, and a focused view of one (or several, merged in time
 * order) showing only its own prompt, messages, tool calls and result.
 */

const STATUS: Record<AgentTaskStatus, { label: string; tone: Tone }> = {
  running: { label: 'Running', tone: 'accent' },
  completed: { label: 'Done', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' },
  stopped: { label: 'Stopped', tone: 'neutral' },
};

function kindView(task: AgentTask): { icon: IconName; label: string } {
  if (task.kind === 'subagent') return { icon: 'bot', label: 'Subagent' };
  if (task.kind === 'workflow') return { icon: 'layers', label: 'Workflow' };
  if (task.agentType === 'monitor') return { icon: 'eye', label: 'Monitor' };
  return { icon: 'terminal', label: 'Background command' };
}

/** The agent that ran it, as recorded when it started: "Claude Code". */
const agentShort = (task: AgentTask) => task.audit?.agentName?.replace(/ \(ACP\)$/, '');

/** The subagent type worth showing; background task types only repeat the kind label. */
const shownType = (task: AgentTask) =>
  task.agentType && !['shell', 'monitor', 'workflow', 'task'].includes(task.agentType) ? task.agentType : undefined;

/** How many tasks the session has and how many are still going, for the tab label. */
export function agentTaskCounts(session: AcpSession): { total: number; running: number } {
  const tasks = session.agentTasks || [];
  return { total: tasks.length, running: tasks.filter((t) => t.status === 'running').length };
}

function allCalls(session: AcpSession): Map<string, ToolCallRecord> {
  const map = new Map<string, ToolCallRecord>();
  for (const turn of session.turns) for (const call of turn.toolCalls || []) map.set(call.id, call);
  return map;
}

/** Calls made inside the task; also matched by parent id for calls recorded before tagging. */
function callsOf(task: AgentTask, calls: Map<string, ToolCallRecord>): ToolCallRecord[] {
  return [...calls.values()].filter(
    (c) => c.agentTaskId === task.id || (task.toolCallId !== undefined && c.parentToolUseId === task.toolCallId)
  );
}

/** The task's own activity in order; calls it made that no segment mentions go at the end. */
function segmentsOf(task: AgentTask, calls: Map<string, ToolCallRecord>): TurnSegment[] {
  const segs = [...(task.segments || [])];
  const listed = new Set(segs.flatMap((s) => (s.kind === 'tool' ? [s.toolCallId] : [])));
  for (const c of callsOf(task, calls).sort((a, b) => a.startedAt - b.startedAt)) {
    if (!listed.has(c.id)) segs.push({ kind: 'tool', id: `seg-${c.id}`, toolCallId: c.id });
  }
  return segs;
}

function taskDuration(task: AgentTask, now: number): string | null {
  if (task.usage?.durationMs != null && task.status !== 'running') return formatDuration(task.usage.durationMs);
  return formatDuration((task.endedAt ?? now) - task.startedAt);
}

/** Ticks once a second while `active`, so running durations count up. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/**
 * While the focused view is open it owns one browser history entry, so the
 * browser's back button (or a phone's back gesture) returns to the list.
 */
function useHistoryEntry(active: boolean, onPop: () => void): void {
  const onPopRef = useRef(onPop);
  onPopRef.current = onPop;
  useEffect(() => {
    if (!active) return;
    window.history.pushState({ agentTaskView: true }, '');
    let popped = false;
    const handler = (e: PopStateEvent) => {
      // Still on one of our entries (a stale back() from a remount landed here): stay open
      if (e.state?.agentTaskView) return;
      popped = true;
      onPopRef.current();
    };
    window.addEventListener('popstate', handler);
    return () => {
      window.removeEventListener('popstate', handler);
      // Closed from the UI: drop the entry we added so back doesn't land on it again
      if (!popped && window.history.state?.agentTaskView) window.history.back();
    };
  }, [active]);
}

/** Esc closes the focused view, unless it is meant for a field or an open dialog. */
function useEscape(active: boolean, onEscape: () => void): void {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) return;
      if (document.querySelector('[role="dialog"]')) return;
      ref.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);
}

export const AgentsPanel: React.FC<{
  session: AcpSession;
  /** Tasks shown in the focused view; empty shows the list. */
  focusedIds: string[];
  onOpen: (ids: string[]) => void;
  onBack: () => void;
  /** Leave for the conversation (the breadcrumb's "Session"). */
  onShowSession: () => void;
}> = ({ session, focusedIds, onOpen, onBack, onShowSession }) => {
  const tasks = session.agentTasks || [];
  const focused = focusedIds.map((id) => tasks.find((t) => t.id === id)).filter((t): t is AgentTask => Boolean(t));
  const isFocused = focused.length > 0;
  useHistoryEntry(isFocused, onBack);
  useEscape(isFocused, onBack);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [focusedIds.join(',')]);

  return (
    <div className="agents-tab" ref={scrollRef}>
      <div className="agents-col">
        {isFocused ? (
          <FocusedView session={session} tasks={focused} onOpen={onOpen} onBack={onBack} onShowSession={onShowSession} />
        ) : (
          <TaskList session={session} tasks={tasks} onOpen={onOpen} />
        )}
      </div>
    </div>
  );
};

// ----------------------------------------------------------------- List

const TaskList: React.FC<{ session: AcpSession; tasks: AgentTask[]; onOpen: (ids: string[]) => void }> = ({
  session,
  tasks,
  onOpen,
}) => {
  const [selected, setSelected] = useState<string[]>([]);
  const calls = useMemo(() => allCalls(session), [session.turns]);
  const running = tasks.filter((t) => t.status === 'running');
  const finished = tasks.filter((t) => t.status !== 'running').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  const now = useNow(running.length > 0);
  const selectable = tasks.length > 1;
  const live = selected.filter((id) => tasks.some((t) => t.id === id));

  useEffect(() => setSelected([]), [session.id]);

  if (tasks.length === 0) {
    return (
      <EmptyState
        icon="bot"
        title="No subagents yet"
        description="When the agent hands work to a subagent, runs a command in the background or starts a workflow, it shows up here. Open one to see only its own activity."
      />
    );
  }

  const toggle = (id: string) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const group = (label: string, items: AgentTask[]) =>
    items.length > 0 && (
      <section className="agents-group" aria-label={label}>
        <h3 className="agents-group-label">
          {label} <span className="agents-group-count">{items.length}</span>
        </h3>
        <ul className="agents-list">
          {items.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              toolCalls={callsOf(task, calls).length}
              parentTitle={tasks.find((t) => t.id === task.parentTaskId)?.title}
              now={now}
              selectable={selectable}
              selected={live.includes(task.id)}
              onToggle={() => toggle(task.id)}
              onOpen={() => onOpen([task.id])}
            />
          ))}
        </ul>
      </section>
    );

  return (
    <>
      <header className="agents-head">
        <h2 className="agents-title">Subagents</h2>
        <p className="agents-desc">
          Subagents, background commands and workflows this session's agent started. Open one to see only its own work.
        </p>
      </header>
      {live.length > 0 && (
        <div className="agents-selectbar" role="region" aria-label="Selected agents">
          <span className="agents-selectbar-count">{live.length} selected</span>
          <Button variant="ghost" size="sm" onClick={() => setSelected([])}>
            Clear
          </Button>
          <Button variant="primary" size="sm" icon="layers" disabled={live.length < 2} onClick={() => onOpen(live)}>
            View together
          </Button>
        </div>
      )}
      {group('Running', running)}
      {group('Finished', finished)}
    </>
  );
};

const TaskRow: React.FC<{
  task: AgentTask;
  toolCalls: number;
  /** The task this one was launched from, for a subagent started by another. */
  parentTitle?: string;
  now: number;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
}> = ({ task, toolCalls, parentTitle, now, selectable, selected, onToggle, onOpen }) => {
  const kind = kindView(task);
  const status = STATUS[task.status];
  const duration = taskDuration(task, now);
  const count = task.usage?.toolUses ?? toolCalls;
  const meta = [
    kind.label,
    shownType(task),
    // The model a subagent ran on can differ from the session's
    task.audit?.subagentModel ?? (task.kind === 'subagent' ? task.audit?.model : undefined),
    parentTitle ? `from ${parentTitle}` : null,
    task.kind !== 'background' || count > 0 ? `${count} tool call${count === 1 ? '' : 's'}` : null,
    duration,
  ].filter(Boolean);
  return (
    <li className={cx('agents-row', selected && 'is-selected', `is-${task.status}`)}>
      {selectable && (
        <label className="agents-check" title="Select to view together with others">
          <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`Select ${task.title}`} />
        </label>
      )}
      <button type="button" className="agents-row-main" onClick={onOpen}>
        <span className={cx('agents-kind', `tone-${status.tone}`)} aria-hidden>
          <Icon name={kind.icon} size={15} />
        </span>
        <span className="agents-row-text">
          <span className="agents-row-title" title={task.title}>
            {task.title}
          </span>
          <span className="agents-row-meta">
            {task.audit?.agentId && (
              <>
                <span className="agents-row-agent" title={`Run by ${agentShort(task)}`}>
                  <VendorIcon agentId={task.audit.agentId} size={11} />
                  {agentShort(task)}
                </span>
                {' · '}
              </>
            )}
            {meta.join(' · ')}
          </span>
        </span>
        <Badge tone={status.tone} title={task.summary}>
          {task.status === 'running' && <Spinner size={9} />}
          {status.label}
        </Badge>
        <Icon name="chevronRight" size={14} className="agents-row-chevron" />
      </button>
    </li>
  );
};

// ---------------------------------------------------------- Focused view

const FocusedView: React.FC<{
  session: AcpSession;
  tasks: AgentTask[];
  onOpen: (ids: string[]) => void;
  onBack: () => void;
  onShowSession: () => void;
}> = ({ session, tasks, onOpen, onBack, onShowSession }) => {
  const calls = useMemo(() => allCalls(session), [session.turns]);
  const single = tasks.length === 1 ? tasks[0] : null;
  const now = useNow(tasks.some((t) => t.status === 'running'));
  const crumb = single ? single.title : `${tasks.length} selected`;

  return (
    <>
      <nav className="agents-crumbs" aria-label="Breadcrumb">
        <IconButton icon="arrowLeft" label="Back to all subagents" size="sm" onClick={onBack} />
        <ol>
          <li>
            <button type="button" className="agents-crumb" onClick={onShowSession}>
              Session
            </button>
          </li>
          <li aria-hidden className="agents-crumb-sep">
            <Icon name="chevronRight" size={12} />
          </li>
          <li>
            <button type="button" className="agents-crumb" onClick={onBack}>
              Subagents
            </button>
          </li>
          <li aria-hidden className="agents-crumb-sep">
            <Icon name="chevronRight" size={12} />
          </li>
          <li className="agents-crumb-current" aria-current="page" title={crumb}>
            {crumb}
          </li>
        </ol>
      </nav>

      {single ? (
        <SingleTask task={single} calls={calls} now={now} />
      ) : (
        <MergedTasks tasks={tasks} calls={calls} now={now} onOpen={onOpen} />
      )}
    </>
  );
};

const TaskHeader: React.FC<{ task: AgentTask; calls: Map<string, ToolCallRecord>; now: number }> = ({ task, calls, now }) => {
  const kind = kindView(task);
  const status = STATUS[task.status];
  const duration = taskDuration(task, now);
  const count = task.usage?.toolUses ?? callsOf(task, calls).length;
  const facts: Array<[string, string]> = [
    ['Started', formatTime(task.startedAt)],
    ...(duration ? [[task.status === 'running' ? 'Running for' : 'Took', duration] as [string, string]] : []),
    // A background command makes no calls of its own
    ...(task.kind !== 'background' ? [['Tool calls', String(count)] as [string, string]] : []),
    ...(task.usage?.totalTokens ? [['Tokens', formatTokens(task.usage.totalTokens)] as [string, string]] : []),
  ];
  return (
    <header className={cx('agents-focus-head', `is-${task.status}`)}>
      <span className={cx('agents-kind is-lg', `tone-${status.tone}`)} aria-hidden>
        <Icon name={kind.icon} size={18} />
      </span>
      <div className="agents-focus-titles">
        <div className="agents-focus-kicker">
          {kind.label}
          {shownType(task) && <span className="subagent-type">{shownType(task)}</span>}
        </div>
        <h2 className="agents-focus-title">{task.title}</h2>
        <dl className="agents-facts">
          {facts.map(([k, v]) => (
            <div key={k} className="agents-fact">
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      <Badge tone={status.tone}>
        {task.status === 'running' && <Spinner size={9} />}
        {status.label}
      </Badge>
    </header>
  );
};

const PROMPT_LABEL: Record<AgentTask['kind'], string> = {
  subagent: 'Task given to the subagent',
  background: 'Command',
  workflow: 'Workflow',
};

const SingleTask: React.FC<{ task: AgentTask; calls: Map<string, ToolCallRecord>; now: number }> = ({ task, calls, now }) => {
  const segments = segmentsOf(task, calls);
  const launch = task.toolCallId ? calls.get(task.toolCallId) : undefined;
  const hasText = segments.some((s) => s.kind === 'text' && s.text.trim());
  const result = task.kind === 'subagent' && launch && !hasText ? subagentResult(launch) : undefined;
  const output = task.kind !== 'subagent' ? launch?.output?.trim() : undefined;
  const running = task.status === 'running';

  return (
    <>
      <TaskHeader task={task} calls={calls} now={now} />
      {task.prompt && (
        <div className={cx('agents-prompt', task.kind === 'background' && 'is-command')}>
          <IoPanel label={PROMPT_LABEL[task.kind]} copy={task.prompt}>
            {task.kind === 'background' ? (
              <span className="io-prompt">
                <span className="io-caret">$</span> {task.prompt}
              </span>
            ) : (
              task.prompt
            )}
          </IoPanel>
        </div>
      )}

      {(task.kind !== 'background' || segments.length > 0) && (
        <section className="agents-activity" aria-label="Activity">
          <h3 className="agents-group-label">Activity</h3>
          {segments.length > 0 ? (
            <Timeline segments={segments} calls={calls} taskRunning={running} />
          ) : running ? (
            <div className="timeline-thinking" role="status">
              <Icon name="sparkles" size={14} />
              <span className="shimmer-text">Working…</span>
            </div>
          ) : (
            <p className="agents-note">
              {task.kind === 'workflow'
                ? 'Claude reports a workflow’s progress totals, not the steps of the agents inside it.'
                : 'This subagent reported no steps.'}
            </p>
          )}
        </section>
      )}

      {(result || output || task.summary) && (
        <section className="agents-result" aria-label="Result">
          <h3 className="agents-group-label">{task.kind === 'subagent' ? 'Report' : 'Result'}</h3>
          {task.summary && <p className={cx('agents-summary', task.status === 'failed' && 'is-failed')}>{task.summary}</p>}
          {result && <MarkdownContent content={result} />}
          {output && (
            <IoPanel label="Output" copy={output}>
              <OutputText text={output} />
            </IoPanel>
          )}
        </section>
      )}

      <TaskDetails task={task} />
    </>
  );
};

/** One copyable id or path in the details list. */
export const DetailValue: React.FC<{ value: string; mono?: boolean }> = ({ value, mono = true }) => {
  const [copied, setCopied] = useState(false);
  return (
    <span className="agents-detail-value">
      <span className={cx(mono && 'mono')} title={value}>
        {value}
      </span>
      <IconButton
        icon={copied ? 'check' : 'copy'}
        size="sm"
        label={copied ? 'Copied' : 'Copy'}
        onClick={async () => {
          if (await copyToClipboard(value)) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }
        }}
      />
    </span>
  );
};

export const exactTime = (ts: number) => new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' });

/** The agent session's id, with a link to it in the Agents tab. */
const AgentSessionLink: React.FC<{ id: string }> = ({ id }) => {
  const open = useOpenAgentSession();
  return (
    <span className="agents-detail-value">
      <DetailValue value={id} />
      {open && (
        <Button size="sm" variant="ghost" onClick={() => open(id)}>
          Show
        </Button>
      )}
    </span>
  );
};

/** Who ran the task and where its records are, for audit. */
const TaskDetails: React.FC<{ task: AgentTask }> = ({ task }) => {
  const a = task.audit;
  const rows: Array<{ label: string; node: React.ReactNode }> = [];
  if (a?.agentId) {
    rows.push({
      label: 'Agent',
      node: (
        <span className="agents-detail-value">
          <VendorIcon agentId={a.agentId} size={13} />
          {agentShort(task)}
        </span>
      ),
    });
  }
  if (a?.model) rows.push({ label: 'Session model', node: <span className="mono">{a.model}</span> });
  if (a?.subagentModel && a.subagentModel !== a.model) rows.push({ label: 'Ran on', node: <span className="mono">{a.subagentModel}</span> });
  if (a?.agentSessionId) rows.push({ label: 'Agent session', node: <AgentSessionLink id={a.agentSessionId} /> });
  if (a?.subagentId) rows.push({ label: 'Subagent id', node: <DetailValue value={a.subagentId} /> });
  if (a?.runId) rows.push({ label: 'Workflow run', node: <DetailValue value={a.runId} /> });
  if (task.toolCallId) rows.push({ label: 'Tool call', node: <DetailValue value={task.toolCallId} /> });
  if (task.asyncTaskId) rows.push({ label: 'Background task', node: <DetailValue value={task.asyncTaskId} /> });
  if (a?.transcriptPath) rows.push({ label: 'Transcript', node: <DetailValue value={a.transcriptPath} /> });
  if (a?.scriptPath) rows.push({ label: 'Script', node: <DetailValue value={a.scriptPath} /> });
  if (a?.worktreePath) {
    rows.push({ label: 'Worktree', node: <DetailValue value={a.worktreeBranch ? `${a.worktreePath} (${a.worktreeBranch})` : a.worktreePath} /> });
  }
  rows.push({ label: 'Started', node: exactTime(task.startedAt) });
  if (task.endedAt) rows.push({ label: 'Ended', node: exactTime(task.endedAt) });

  return (
    <section className="agents-details" aria-label="Details">
      <h3 className="agents-group-label">Details</h3>
      {!a?.agentId && <p className="agents-note">Started before CodePit recorded which agent session ran each task; only its ids are known.</p>}
      <dl className="agents-detail-list">
        {rows.map((r) => (
          <div key={r.label} className="agents-detail-row">
            <dt>{r.label}</dt>
            <dd>{r.node}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
};

/** Renders a task's segments: messages as prose, runs of calls and reasoning as a compact list. */
const Timeline: React.FC<{ segments: TurnSegment[]; calls: Map<string, ToolCallRecord>; taskRunning: boolean }> = ({
  segments,
  calls,
  taskRunning,
}) => {
  const blocks: Array<{ key: string; text?: string; items?: TurnSegment[]; subagent?: ToolCallRecord }> = [];
  for (const seg of segments) {
    if (seg.kind === 'text') {
      if (seg.text.trim()) blocks.push({ key: seg.id, text: seg.text });
      continue;
    }
    const call = seg.kind === 'tool' ? calls.get(seg.toolCallId) : undefined;
    if (seg.kind === 'tool' && !call) continue;
    if (call?.isSubagent) {
      blocks.push({ key: seg.id, subagent: call });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (last?.items) last.items.push(seg);
    else blocks.push({ key: seg.id, items: [seg] });
  }
  const childrenOf = (id: string) => [...calls.values()].filter((c) => c.parentToolUseId === id);

  return (
    <div className="turn-timeline">
      {blocks.map((b) => {
        if (b.text != null) {
          return (
            <div key={b.key} className="timeline-message">
              <MarkdownContent content={b.text} />
            </div>
          );
        }
        if (b.subagent) return <SubagentCard key={b.key} call={b.subagent} childCalls={childrenOf(b.subagent.id)} />;
        return (
          <div key={b.key} className="activity-items">
            {b.items!.map((seg) => {
              if (seg.kind === 'thought') return <ThoughtRow key={seg.id} text={seg.text} live={false} />;
              const call = calls.get((seg as Extract<TurnSegment, { kind: 'tool' }>).toolCallId)!;
              // A call still marked as going in a task that has ended was cut off
              return <ToolRow key={seg.id} call={call} interrupted={!taskRunning && isActive(call)} />;
            })}
          </div>
        );
      })}
    </div>
  );
};

/**
 * Several tasks' activity interleaved by time. Messages and reasoning carry no
 * timestamp of their own, so each takes the time of the call before it.
 */
const MergedTasks: React.FC<{
  tasks: AgentTask[];
  calls: Map<string, ToolCallRecord>;
  now: number;
  onOpen: (ids: string[]) => void;
}> = ({ tasks, calls, now, onOpen }) => {
  const entries: Array<{ task: AgentTask; seg: TurnSegment; at: number; order: number }> = [];
  for (const task of tasks) {
    let at = task.startedAt;
    segmentsOf(task, calls).forEach((seg, i) => {
      if (seg.kind === 'tool') at = calls.get(seg.toolCallId)?.startedAt ?? at;
      entries.push({ task, seg, at, order: i });
    });
  }
  entries.sort((a, b) => a.at - b.at || (a.task === b.task ? a.order - b.order : 0));

  // Consecutive entries from the same task share one source heading.
  const runs: Array<{ task: AgentTask; segs: TurnSegment[] }> = [];
  for (const e of entries) {
    const last = runs[runs.length - 1];
    if (last && last.task === e.task) last.segs.push(e.seg);
    else runs.push({ task: e.task, segs: [e.seg] });
  }

  return (
    <>
      <header className="agents-head">
        <h2 className="agents-title">{tasks.length} agents together</h2>
        <p className="agents-desc">Their activity interleaved in the order it happened.</p>
      </header>
      <ul className="agents-list">
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            toolCalls={callsOf(task, calls).length}
            now={now}
            selectable={false}
            selected={false}
            onToggle={() => {}}
            onOpen={() => onOpen([task.id])}
          />
        ))}
      </ul>
      <section className="agents-activity" aria-label="Activity">
        <h3 className="agents-group-label">Activity</h3>
        {runs.length === 0 ? (
          <p className="agents-note">None of these reported any steps yet.</p>
        ) : (
          runs.map((run, i) => (
            <div key={`${run.task.id}-${i}`} className="agents-merge-run">
              <div className="agents-merge-source">
                <Icon name={kindView(run.task).icon} size={12} />
                <span>{run.task.title}</span>
              </div>
              <Timeline segments={run.segs} calls={calls} taskRunning={run.task.status === 'running'} />
            </div>
          ))
        )}
      </section>
    </>
  );
};
