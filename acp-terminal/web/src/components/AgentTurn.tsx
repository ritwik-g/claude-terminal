import React, { useEffect, useRef, useState } from 'react';
import type { ToolCallRecord, TurnMessage, TurnSegment } from '../types';
import { MarkdownContent } from './MarkdownContent';
import { Badge, Button, Icon, IconButton, Spinner, type Tone } from '../ui';
import {
  commandOf,
  copyToClipboard,
  describeTool,
  durationLabel,
  editDiff,
  formatDuration,
  isActive,
  isFailed,
  segmentsOf,
  subagentResult,
  subagentStats,
  subagentStatus,
  summarizeActivity,
  toolInput,
  type SubagentStatus,
} from '../toolDisplay';

interface AgentTurnBodyProps {
  turn: TurnMessage;
  /** This is the newest turn and the agent is still producing it. */
  isActiveTurn: boolean;
  /** The newest turn is waiting on a permission decision. */
  isAwaitingApproval: boolean;
}

type ThoughtSegment = Extract<TurnSegment, { kind: 'thought' }>;
type ActivityItem = ThoughtSegment | ToolCallRecord;

type Block =
  | { type: 'text'; seg: Extract<TurnSegment, { kind: 'text' }> }
  | { type: 'activity'; key: string; items: ActivityItem[] }
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
            stale={!isActiveTurn}
            isAwaitingApproval={isAwaitingApproval && isLastBlock}
          />
        );
      })}
      {isActiveTurn && blocks.length === 0 && (
        <div className="timeline-thinking" role="status">
          <Icon name="sparkles" size={14} />
          <span className="shimmer-text">Thinking…</span>
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
  items: ActivityItem[];
  live: boolean;
  /** The turn is over, so a call still marked as going was cut off. */
  stale: boolean;
  isAwaitingApproval: boolean;
}> = ({ items, live, stale, isAwaitingApproval }) => {
  const [expanded, setExpanded] = useState(false);
  // Tool calls carry a status; reasoning segments don't.
  const tools = items.filter((i): i is ToolCallRecord => 'status' in i);
  const running = tools.some((t) => isActive(t) && !isInterrupted(t, stale));
  const failed = tools.some(isFailed);
  // Long finished runs fold into one summary line; anything live stays open.
  const collapsible = !live && !running && items.length > COLLAPSE_AFTER;
  const showItems = !collapsible || expanded;

  return (
    <div className={`activity-group${live ? ' is-live' : ''}`}>
      {collapsible && (
        <button
          type="button"
          className={`activity-summary${failed ? ' has-failed' : ''}`}
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          <span className="activity-summary-icon">
            <Icon name="layers" size={13} />
          </span>
          <SummaryText text={summarizeActivity(tools, items.length - tools.length)} />
          <Icon name="chevronRight" size={13} className="activity-summary-chevron" />
        </button>
      )}
      {showItems && (
        <div className="activity-items">
          {items.map((item) =>
            'status' in item ? (
              <ToolRow
                key={item.id}
                call={item}
                awaitingApproval={isAwaitingApproval && isActive(item)}
                interrupted={isInterrupted(item, stale)}
              />
            ) : (
              <ThoughtRow key={item.id} text={item.text} live={live && item === items[items.length - 1]} />
            )
          )}
        </div>
      )}
    </div>
  );
};

/** The summary line, with a trailing "· N failed" picked out in the danger tone. */
const SummaryText: React.FC<{ text: string }> = ({ text }) => {
  const m = text.match(/^(.*?)( · \d+ failed)$/);
  return (
    <span className="activity-summary-text">
      {m ? m[1] : text}
      {m && <span className="activity-summary-failed">{m[2]}</span>}
    </span>
  );
};

/**
 * A call still pending or running in a turn that has ended never got its final
 * update (the agent stopped or the server restarted mid-call). Background work
 * legitimately outlives its turn, so it is left alone.
 */
const isInterrupted = (call: ToolCallRecord, stale: boolean) => stale && isActive(call) && !call.background;

const StatusGlyph: React.FC<{ call: ToolCallRecord; awaitingApproval?: boolean; interrupted?: boolean }> = ({
  call,
  awaitingApproval,
  interrupted,
}) => {
  let content: React.ReactNode;
  let tone = 'ok';
  if (interrupted) {
    tone = 'neutral';
    content = <Icon name="stop" size={12} title="Interrupted" />;
  } else if (awaitingApproval) {
    tone = 'warn';
    content = <Icon name="alert" size={13} title="Waiting for approval" />;
  } else if (isActive(call)) {
    tone = 'accent';
    content = <Spinner size={11} />;
  } else if (isFailed(call)) {
    tone = 'danger';
    content = <Icon name="x" size={13} title="Failed" />;
  } else if (call.background) {
    tone = 'neutral';
    content = <Icon name="clock" size={13} title="Running in background" />;
  } else {
    content = <Icon name="check" size={13} title="Done" />;
  }
  return <span className={`tool-status tone-${tone}`}>{content}</span>;
};

/** Copy button for detail panels; flips to a check for a moment after copying. */
export const CopyButton: React.FC<{ text: string; label?: string; withText?: boolean }> = ({
  text,
  label = 'Copy',
  withText,
}) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const onCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (await copyToClipboard(text)) {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    }
  };
  if (withText) {
    return (
      <Button
        variant="ghost"
        size="sm"
        icon={copied ? 'check' : 'copy'}
        onClick={onCopy}
        className={copied ? 'is-copied' : undefined}
      >
        {copied ? 'Copied' : label}
      </Button>
    );
  }
  return (
    <IconButton
      icon={copied ? 'check' : 'copy'}
      label={copied ? 'Copied' : label}
      size="sm"
      tone={copied ? 'ok' : 'default'}
      active={copied}
      onClick={onCopy}
      className="io-copy"
    />
  );
};

// The server keeps the head and tail of very large tool output and joins them
// with this marker (see capToolOutput in server/acp/client-host.ts).
const TRUNCATION = /\n*\.\.\. \[output truncated: (\d+) KB\] \.\.\.\n?/;

/** Tool output, with the server's truncation marker drawn as a divider instead of raw text. */
export const OutputText: React.FC<{ text: string }> = ({ text }) => {
  const m = text.match(TRUNCATION);
  if (!m || m.index == null) return <>{text}</>;
  return (
    <>
      {text.slice(0, m.index)}
      <span className="io-truncated" role="note">
        Output trimmed: showing the start and end of {m[1]} KB
      </span>
      {text.slice(m.index + m[0].length)}
    </>
  );
};

const IoPanel: React.FC<{
  label: React.ReactNode;
  copy?: string;
  tone?: 'danger';
  children: React.ReactNode;
}> = ({ label, copy, tone, children }) => (
  <div className={`io-panel${tone ? ` is-${tone}` : ''}`}>
    <div className="io-panel-head">
      <span className="io-panel-label">{label}</span>
      {copy != null && <CopyButton text={copy} label="Copy" />}
    </div>
    <pre className="io-panel-body">{children}</pre>
  </div>
);

const DiffView: React.FC<{ diff: NonNullable<ReturnType<typeof editDiff>> }> = ({ diff }) => {
  const lines = diff.hunks.flatMap((h) => h.lines);
  const added = lines.filter((l) => l.type === 'add').length;
  const removed = lines.filter((l) => l.type === 'del').length;
  const newText = diff.hunks
    .map((h) => h.lines.filter((l) => l.type !== 'del').map((l) => l.text).join('\n'))
    .join('\n');
  return (
    <div className="io-panel diff-panel">
      <div className="io-panel-head">
        <span className="io-panel-label mono" title={diff.path}>
          {diff.path ? diff.path.split('/').slice(-3).join('/') : 'Changes'}
        </span>
        <span className="diff-stat">
          <span className="diff-stat-add">+{added}</span>
          <span className="diff-stat-del">−{removed}</span>
        </span>
        <CopyButton text={newText} label="Copy new text" />
      </div>
      <div className="diff-body">
        {diff.hunks.map((h, hi) => (
          <div key={hi} className="diff-hunk">
            {h.lines.map((l, li) => (
              <div key={li} className={`diff-line is-${l.type}`}>
                <span className="diff-sign" aria-hidden>
                  {l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}
                </span>
                <span className="sr-only">{l.type === 'add' ? 'Added: ' : l.type === 'del' ? 'Removed: ' : ''}</span>
                <span className="diff-text">{l.text || ' '}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};

// Input keys that only repeat what the row already says.
const QUIET_KEYS = new Set(['file_path', 'path', 'notebook_path', 'description']);

export const ToolRow: React.FC<{ call: ToolCallRecord; awaitingApproval?: boolean; interrupted?: boolean }> = ({
  call,
  awaitingApproval,
  interrupted,
}) => {
  const [open, setOpen] = useState(false);
  const d = describeTool(call, interrupted);
  const output = call.output?.trim();
  const input = toolInput(call);
  const isCommand = d.icon === 'terminal';
  const command = isCommand ? commandOf(call) : undefined;
  const diff = editDiff(call);
  const extraInput = Object.keys(input).some((k) => !QUIET_KEYS.has(k));
  const hasDetail = Boolean(output || call.error || command || diff || (!isCommand && extraInput));
  const duration = durationLabel(call);
  const failedExit = call.exitCode != null && call.exitCode !== 0;
  const failed = isFailed(call);

  return (
    <div className={`tool-row${open ? ' is-open' : ''}${awaitingApproval ? ' is-awaiting' : ''}${failed ? ' is-failed' : ''}`}>
      <button
        type="button"
        className="tool-row-head"
        onClick={() => hasDetail && setOpen(!open)}
        aria-expanded={hasDetail ? open : undefined}
        disabled={!hasDetail}
      >
        <StatusGlyph call={call} awaitingApproval={awaitingApproval} interrupted={interrupted} />
        <Icon name={d.icon} size={14} className="tool-kind" />
        {d.verb && <span className="tool-verb">{d.verb}</span>}
        <span className={`tool-target${d.mono ? ' mono' : ''}`} title={d.target}>
          {d.target}
        </span>
        {call.description && isCommand && <span className="tool-desc">{call.description}</span>}
        <span className="tool-meta">
          {awaitingApproval && (
            <Badge tone="warn" dot>
              Needs approval
            </Badge>
          )}
          {interrupted && <Badge tone="neutral">Interrupted</Badge>}
          {call.background && !isActive(call) && <Badge tone="info">Background</Badge>}
          {failedExit ? (
            <Badge tone="danger" mono>
              exit {call.exitCode}
            </Badge>
          ) : (
            call.status === 'failed' && <Badge tone="danger">Failed</Badge>
          )}
          {duration && <span className="tool-duration">{duration}</span>}
          {hasDetail && <Icon name="chevronRight" size={13} className="tool-chevron" />}
        </span>
      </button>
      {open && (
        <div className="tool-row-body">
          {command != null && (
            <IoPanel label="Shell" copy={output ? `$ ${command}\n${output}` : command}>
              <span className="io-prompt">
                <span className="io-caret">$</span> {command}
              </span>
              {output ? (
                <>
                  {'\n'}
                  <OutputText text={output} />
                </>
              ) : null}
            </IoPanel>
          )}
          {diff && <DiffView diff={diff} />}
          {!isCommand && !diff && extraInput && (
            <IoPanel label="Input" copy={JSON.stringify(call.input, null, 2)}>
              {JSON.stringify(call.input, null, 2)}
            </IoPanel>
          )}
          {!isCommand && output && (
            <IoPanel label="Output" copy={output}>
              <OutputText text={output} />
            </IoPanel>
          )}
          {call.error && (
            <IoPanel label="Error" tone="danger" copy={String(call.error)}>
              {String(call.error)}
            </IoPanel>
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
    <div className={`tool-row thought-row${open ? ' is-open' : ''}`}>
      <button type="button" className="tool-row-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`tool-status tone-${live ? 'accent' : 'neutral'}`}>
          {live ? <Spinner size={11} /> : <Icon name="brain" size={13} />}
        </span>
        <span className={`tool-verb${live ? ' shimmer-text' : ''}`}>{live ? 'Thinking' : 'Thought'}</span>
        {!open && <span className="tool-target thought-preview">{firstLine}</span>}
        <span className="tool-meta">
          <Icon name="chevronRight" size={13} className="tool-chevron" />
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

const SUBAGENT_BADGE: Record<SubagentStatus, { label: string; tone: Tone }> = {
  running: { label: 'Running', tone: 'accent' },
  background: { label: 'In background', tone: 'info' },
  done: { label: 'Done', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' },
};

export const SubagentCard: React.FC<{ call: ToolCallRecord; childCalls: ToolCallRecord[] }> = ({ call, childCalls }) => {
  const status = subagentStatus(call, childCalls);
  const [showSteps, setShowSteps] = useState(false);
  const [showTask, setShowTask] = useState(false);
  const result = subagentResult(call);
  const stats = subagentStats(call);
  const prompt = toolInput(call).prompt as string | undefined;
  const liveChild = childCalls.find(isActive);
  const failedSteps = childCalls.filter(isFailed).length;
  const badge = SUBAGENT_BADGE[status];
  const live = status === 'running' || status === 'background';
  const title = call.description || describeTool(call).target;
  const statParts = [
    stats.toolUses != null ? `${stats.toolUses} tool use${stats.toolUses === 1 ? '' : 's'}` : null,
    stats.durationMs != null ? formatDuration(stats.durationMs) : null,
  ].filter(Boolean);

  return (
    <section className={`subagent-card is-${status}`} aria-label={`Subagent: ${title}`}>
      <header className="subagent-head">
        <span className="subagent-icon">
          <Icon name="bot" size={15} />
        </span>
        <div className="subagent-titles">
          <div className="subagent-kicker">
            Subagent
            {call.subagentType && <span className="subagent-type">{call.subagentType}</span>}
          </div>
          <div className="subagent-title" title={title}>
            {title}
          </div>
        </div>
        <div className="subagent-aside">
          {status === 'done' && statParts.length > 0 && <span className="subagent-stats">{statParts.join(' · ')}</span>}
          <Badge tone={badge.tone}>
            {live && <Spinner size={9} />}
            {badge.label}
          </Badge>
        </div>
      </header>

      {liveChild && !showSteps && (
        <div className="subagent-live">
          <ToolRow call={liveChild} />
        </div>
      )}

      {(childCalls.length > 0 || prompt) && (
        <div className="subagent-toggles">
          {childCalls.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              icon={showSteps ? 'chevronDown' : 'chevronRight'}
              onClick={() => setShowSteps(!showSteps)}
              aria-expanded={showSteps}
            >
              {childCalls.length} step{childCalls.length === 1 ? '' : 's'}
              {failedSteps > 0 && <span className="subagent-toggle-fail"> · {failedSteps} failed</span>}
            </Button>
          )}
          {prompt && (
            <Button
              variant="ghost"
              size="sm"
              icon={showTask ? 'chevronDown' : 'chevronRight'}
              onClick={() => setShowTask(!showTask)}
              aria-expanded={showTask}
            >
              Task
            </Button>
          )}
        </div>
      )}

      {showTask && prompt && (
        <div className="subagent-task">
          <IoPanel label="Task given to the subagent" copy={prompt}>
            {prompt}
          </IoPanel>
        </div>
      )}
      {showSteps && (
        <div className="subagent-steps activity-items">
          {childCalls.map((c) => (
            <ToolRow key={c.id} call={c} />
          ))}
        </div>
      )}
      {result ? (
        <div className="subagent-result">
          <div className="subagent-result-label">Report</div>
          <MarkdownContent content={result} />
        </div>
      ) : (
        live && (
          <div className="subagent-pending">
            <span className="shimmer-text">{status === 'background' ? 'Working in the background…' : 'Working…'}</span>
          </div>
        )
      )}
    </section>
  );
};
