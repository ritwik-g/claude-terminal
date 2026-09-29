import React, { useState } from 'react';
import type { ToolCallRecord, TurnMessage, TurnSegment } from '../types';
import { MarkdownContent } from './MarkdownContent';
import { Icon, Spinner } from './Icons';
import {
  describeTool,
  durationLabel,
  isActive,
  segmentsOf,
  subagentResult,
  subagentStats,
  subagentStatus,
  toolInput,
} from '../toolDisplay';

interface AgentTurnBodyProps {
  turn: TurnMessage;
  /** This is the newest turn and the agent is still producing it. */
  isActiveTurn: boolean;
  /** The newest turn is waiting on a permission decision. */
  isAwaitingApproval: boolean;
}

type Block =
  | { type: 'text'; seg: Extract<TurnSegment, { kind: 'text' }> }
  | { type: 'activity'; key: string; items: Array<Extract<TurnSegment, { kind: 'thought' }> | ToolCallRecord> }
  | { type: 'subagent'; call: ToolCallRecord };

/**
 * Renders an agent turn in the order things happened: each message the agent
 * wrote is its own block, runs of tool calls and reasoning between them are
 * grouped into a compact activity list, and subagents get their own card.
 */
const AgentTurnBodyImpl: React.FC<AgentTurnBodyProps> = ({ turn, isActiveTurn, isAwaitingApproval }) => {
  const calls = new Map((turn.toolCalls || []).map((c) => [c.id, c]));
  const childrenOf = (id: string) => (turn.toolCalls || []).filter((c) => c.parentToolUseId === id);

  const blocks: Block[] = [];
  for (const seg of segmentsOf(turn)) {
    if (seg.kind === 'text') {
      if (seg.text.trim()) blocks.push({ type: 'text', seg });
      continue;
    }
    if (seg.kind === 'tool') {
      const call = calls.get(seg.toolCallId);
      if (!call) continue;
      if (call.isSubagent) {
        blocks.push({ type: 'subagent', call });
        continue;
      }
    }
    const item = seg.kind === 'tool' ? calls.get(seg.toolCallId)! : seg;
    const last = blocks[blocks.length - 1];
    if (last?.type === 'activity') last.items.push(item);
    else blocks.push({ type: 'activity', key: seg.id, items: [item] });
  }

  return (
    <div className="turn-timeline">
      {blocks.map((block, i) => {
        const isLastBlock = i === blocks.length - 1;
        if (block.type === 'text') {
          return (
            <div key={block.seg.id} className="timeline-message">
              <MarkdownContent content={block.seg.text} />
            </div>
          );
        }
        if (block.type === 'subagent') {
          return <SubagentCard key={block.call.id} call={block.call} childCalls={childrenOf(block.call.id)} />;
        }
        return (
          <ActivityGroup
            key={block.key}
            items={block.items}
            live={isActiveTurn && isLastBlock}
            isAwaitingApproval={isAwaitingApproval && isLastBlock}
          />
        );
      })}
      {isActiveTurn && blocks.length === 0 && (
        <div className="timeline-thinking">
          <Spinner /> <span>Thinking…</span>
        </div>
      )}
    </div>
  );
};

// Streaming replaces only the turn being updated, so memoizing on props keeps
// every other turn from re-rendering on each chunk.
export const AgentTurnBody = React.memo(AgentTurnBodyImpl);

const COLLAPSE_AFTER = 3;

const ActivityGroup: React.FC<{
  items: Array<Extract<TurnSegment, { kind: 'thought' }> | ToolCallRecord>;
  live: boolean;
  isAwaitingApproval: boolean;
}> = ({ items, live, isAwaitingApproval }) => {
  const [expanded, setExpanded] = useState(false);
  // Tool calls carry a status; reasoning segments don't.
  const tools = items.filter((i): i is ToolCallRecord => 'status' in i);
  const running = tools.some(isActive);
  // Long finished runs fold into one summary line; anything live stays open.
  const collapsible = !live && !running && items.length > COLLAPSE_AFTER;
  const visible = collapsible && !expanded ? [] : items;

  return (
    <div className="activity-group">
      {collapsible && (
        <button type="button" className="activity-summary" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
          <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} />
          <span>{summarize(tools, items.length - tools.length)}</span>
        </button>
      )}
      {visible.map((item) =>
        'status' in item ? (
          <ToolRow
            key={item.id}
            call={item}
            awaitingApproval={isAwaitingApproval && isActive(item)}
          />
        ) : (
          <ThoughtRow key={item.id} text={item.text} live={live && item === items[items.length - 1]} />
        )
      )}
    </div>
  );
};

function summarize(tools: ToolCallRecord[], thoughts: number): string {
  const counts = new Map<string, number>();
  for (const t of tools) {
    const d = describeTool(t);
    const key = d.icon === 'terminal' ? 'command' : d.icon === 'file' ? 'file read' : d.icon === 'fileEdit' ? 'edit' : d.icon === 'search' ? 'search' : 'tool call';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const plural = (k: string) => (k.endsWith('ch') ? `${k}es` : `${k}s`);
  const parts = [...counts.entries()].map(([k, n]) => `${n} ${n === 1 ? k : plural(k)}`);
  if (thoughts) parts.push(`${thoughts} reasoning step${thoughts === 1 ? '' : 's'}`);
  const failed = tools.filter((t) => t.status === 'failed' || (t.exitCode != null && t.exitCode !== 0)).length;
  return `${parts.join(', ')}${failed ? ` · ${failed} failed` : ''}`;
}

const StatusGlyph: React.FC<{ call: ToolCallRecord; awaitingApproval?: boolean }> = ({ call, awaitingApproval }) => {
  if (awaitingApproval) return <Icon name="alert" size={14} className="glyph-warn" title="Waiting for approval" />;
  if (isActive(call)) return <Spinner size={12} />;
  if (call.status === 'failed' || (call.exitCode != null && call.exitCode !== 0)) {
    return <Icon name="x" size={14} className="glyph-fail" title="Failed" />;
  }
  if (call.background) return <Icon name="clock" size={14} className="glyph-muted" title="Running in background" />;
  return <Icon name="check" size={14} className="glyph-ok" title="Done" />;
};

export const ToolRow: React.FC<{ call: ToolCallRecord; awaitingApproval?: boolean }> = ({ call, awaitingApproval }) => {
  const [open, setOpen] = useState(false);
  const d = describeTool(call);
  const output = call.output?.trim();
  const input = toolInput(call);
  const hasDetail = Boolean(output || call.error || input.command || input.content || input.new_string);
  const duration = durationLabel(call);
  const failedExit = call.exitCode != null && call.exitCode !== 0;

  return (
    <div className={`tool-row ${open ? 'open' : ''} ${awaitingApproval ? 'awaiting' : ''}`}>
      <button
        type="button"
        className="tool-row-head"
        onClick={() => hasDetail && setOpen(!open)}
        aria-expanded={hasDetail ? open : undefined}
        disabled={!hasDetail}
      >
        <StatusGlyph call={call} awaitingApproval={awaitingApproval} />
        <Icon name={d.icon} size={14} className="glyph-kind" />
        {d.verb && <span className="tool-verb">{d.verb}</span>}
        <span className={`tool-target ${d.mono ? 'mono' : ''}`} title={d.target}>
          {d.target}
        </span>
        {call.description && d.icon === 'terminal' && <span className="tool-desc">{call.description}</span>}
        <span className="tool-meta">
          {awaitingApproval && <span className="pill pill-warn">needs approval</span>}
          {call.background && !isActive(call) && <span className="pill">background</span>}
          {failedExit && <span className="pill pill-fail">exit {call.exitCode}</span>}
          {duration && <span>{duration}</span>}
          {hasDetail && <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />}
        </span>
      </button>
      {open && (
        <div className="tool-row-body">
          {input.command && d.icon === 'terminal' && <pre className="tool-io tool-cmd">$ {input.command}</pre>}
          {output && <pre className="tool-io">{output}</pre>}
          {call.error && <pre className="tool-io tool-err">{String(call.error)}</pre>}
          {!output && !call.error && d.icon !== 'terminal' && (
            <pre className="tool-io">{JSON.stringify(call.input, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  );
};

const ThoughtRow: React.FC<{ text: string; live: boolean }> = ({ text, live }) => {
  const [open, setOpen] = useState(false);
  const firstLine = text.trim().split('\n')[0].replace(/[*_#`]/g, '');
  return (
    <div className={`tool-row thought ${open ? 'open' : ''}`}>
      <button type="button" className="tool-row-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {live ? <Spinner size={12} /> : <Icon name="brain" size={14} className="glyph-muted" />}
        <span className="tool-verb">Thinking</span>
        {!open && <span className="tool-target thought-preview">{firstLine}</span>}
        <span className="tool-meta">
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />
        </span>
      </button>
      {open && (
        <div className="tool-row-body thought-body">
          <MarkdownContent content={text} />
        </div>
      )}
    </div>
  );
};

const SUBAGENT_LABEL: Record<string, string> = {
  running: 'Running',
  background: 'Running in background',
  done: 'Done',
  failed: 'Failed',
};

export const SubagentCard: React.FC<{ call: ToolCallRecord; childCalls: ToolCallRecord[] }> = ({ call, childCalls }) => {
  const status = subagentStatus(call, childCalls);
  const [showSteps, setShowSteps] = useState(false);
  const [showTask, setShowTask] = useState(false);
  const result = subagentResult(call);
  const stats = subagentStats(call);
  const prompt = toolInput(call).prompt as string | undefined;
  const liveChild = childCalls.find(isActive);

  return (
    <div className={`subagent-card status-${status}`}>
      <div className="subagent-head">
        <span className="subagent-icon">
          <Icon name="bot" size={15} />
        </span>
        <div className="subagent-titles">
          <div className="subagent-kicker">
            Subagent{call.subagentType ? ` · ${call.subagentType}` : ''}
          </div>
          <div className="subagent-title">{call.description || describeTool(call).target}</div>
        </div>
        {status === 'done' && (stats.toolUses != null || stats.durationMs != null) && (
          <span className="subagent-stats">
            {stats.toolUses != null && `${stats.toolUses} tool use${stats.toolUses === 1 ? '' : 's'}`}
            {stats.toolUses != null && stats.durationMs != null && ' · '}
            {stats.durationMs != null && `${(stats.durationMs / 1000).toFixed(1)}s`}
          </span>
        )}
        <span className={`pill subagent-pill ${status}`}>
          {(status === 'running' || status === 'background') && <Spinner size={10} />}
          {SUBAGENT_LABEL[status]}
        </span>
      </div>

      {liveChild && !showSteps && (
        <div className="subagent-live">
          <ToolRow call={liveChild} />
        </div>
      )}

      <div className="subagent-links">
        {childCalls.length > 0 && (
          <button type="button" className="link-btn" onClick={() => setShowSteps(!showSteps)} aria-expanded={showSteps}>
            <Icon name={showSteps ? 'chevronDown' : 'chevronRight'} size={13} />
            {childCalls.length} step{childCalls.length === 1 ? '' : 's'}
          </button>
        )}
        {prompt && (
          <button type="button" className="link-btn" onClick={() => setShowTask(!showTask)} aria-expanded={showTask}>
            <Icon name={showTask ? 'chevronDown' : 'chevronRight'} size={13} />
            Task
          </button>
        )}
      </div>

      {showTask && prompt && <pre className="tool-io subagent-task">{prompt}</pre>}
      {showSteps && (
        <div className="subagent-steps">
          {childCalls.map((c) => (
            <ToolRow key={c.id} call={c} />
          ))}
        </div>
      )}
      {result && (
        <div className="subagent-result">
          <MarkdownContent content={result} />
        </div>
      )}
    </div>
  );
};
