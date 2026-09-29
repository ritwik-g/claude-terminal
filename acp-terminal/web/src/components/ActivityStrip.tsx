import React, { useEffect, useRef, useState } from 'react';
import type { AcpSession, PlanEntry, ToolCallRecord } from '../types';
import { Badge, Icon, Progress, Spinner } from '../ui';
import { backgroundRunning, commandOf, describeTool, isActive, liveCallIds, subagentStatus } from '../toolDisplay';

/**
 * A strip above the conversation answering "what is going on right now?":
 * the agent's todo list, subagents still working, and commands running in the
 * foreground or background for the current request.
 */
export const ActivityStrip: React.FC<{ session: AcpSession }> = ({ session }) => {
  const [planOpen, setPlanOpen] = useState(false);
  const planRef = useRef<HTMLDivElement>(null);
  const plan = session.plan || [];
  const done = plan.filter((p) => p.status === 'completed').length;
  const current = plan.find((p) => p.status === 'in_progress');
  const allDone = plan.length > 0 && done === plan.length;

  // Only the current exchange: everything after the last user message.
  const lastUser = session.turns.map((t) => t.role).lastIndexOf('user');
  const live = liveCallIds(session);
  // Calls cut off by a stop or restart stay "running" forever; leave them out.
  const recent = session.turns
    .slice(lastUser + 1)
    .flatMap((t) => t.toolCalls || [])
    .filter((c) => !isActive(c) || live.has(c.id));
  const all = session.turns.flatMap((t) => t.toolCalls || []);
  const childrenOf = (id: string) => all.filter((c) => c.parentToolUseId === id);

  const subagents = recent
    .filter((c) => c.isSubagent)
    .map((c) => ({ call: c, status: subagentStatus(c, childrenOf(c.id)) }))
    .filter((s) => s.status === 'running' || s.status === 'background');
  const commands = recent.filter(
    (c): c is ToolCallRecord => !c.isSubagent && !c.parentToolUseId && Boolean(commandOf(c)) && (isActive(c) || backgroundRunning(c))
  );

  // Close the plan popover on Escape or a click elsewhere.
  useEffect(() => {
    if (!planOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPlanOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (planRef.current && !planRef.current.contains(e.target as Node)) setPlanOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [planOpen]);

  if (plan.length === 0 && subagents.length === 0 && commands.length === 0) return null;

  return (
    <div className="activity-strip" role="region" aria-label="Current activity">
      <div className="activity-strip-inner">
        {plan.length > 0 && (
          <div className="strip-plan" ref={planRef}>
            <button
              type="button"
              className={`strip-chip plan-chip${planOpen ? ' is-open' : ''}${allDone ? ' is-done' : ''}`}
              onClick={() => setPlanOpen(!planOpen)}
              aria-expanded={planOpen}
              aria-controls="activity-plan"
            >
              <Icon name={allDone ? 'checkCircle' : 'list'} size={13} className="strip-chip-icon" />
              <span className="strip-chip-label">Plan</span>
              <span className="plan-chip-progress">
                <Progress value={(done / plan.length) * 100} size="sm" tone={allDone ? 'ok' : 'accent'} label="Plan progress" />
              </span>
              <span className="strip-chip-count">
                {done}/{plan.length}
              </span>
              {current && <span className="strip-chip-detail">{current.content}</span>}
              <Icon name="chevronDown" size={12} className="strip-chip-chevron" />
            </button>
            {planOpen && (
              <div className="plan-popover" id="activity-plan" role="dialog" aria-label="Plan">
                <div className="plan-popover-head">
                  <span className="plan-popover-title">Plan</span>
                  <span className="plan-popover-count">
                    {done} of {plan.length} done
                  </span>
                </div>
                <Progress value={(done / plan.length) * 100} size="sm" tone={allDone ? 'ok' : 'accent'} label="Plan progress" />
                <ol className="plan-list">
                  {plan.map((entry, i) => (
                    <PlanItem key={i} entry={entry} />
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}
        {subagents.map(({ call, status }) => (
          <span key={call.id} className="strip-chip is-running" title={call.description || call.title}>
            <Spinner size={10} />
            <Icon name="bot" size={13} className="strip-chip-icon" />
            <span className="strip-chip-detail">{call.description || describeTool(call).target}</span>
            {status === 'background' && <Badge tone="info">Background</Badge>}
          </span>
        ))}
        {commands.map((call) => (
          <span key={call.id} className={`strip-chip${isActive(call) ? ' is-running' : ''}`} title={commandOf(call)}>
            {isActive(call) ? <Spinner size={10} /> : <Icon name="clock" size={12} className="strip-chip-icon" />}
            <Icon name="terminal" size={13} className="strip-chip-icon" />
            <span className="strip-chip-detail mono">{commandOf(call)}</span>
            {backgroundRunning(call) && <Badge tone="info">Background</Badge>}
          </span>
        ))}
      </div>
    </div>
  );
};

const PLAN_STATE_LABEL: Record<PlanEntry['status'], string> = {
  completed: 'Done',
  in_progress: 'In progress',
  pending: 'To do',
};

const PlanItem: React.FC<{ entry: PlanEntry }> = ({ entry }) => (
  <li className={`plan-item is-${entry.status}`}>
    <span className="plan-check" aria-label={PLAN_STATE_LABEL[entry.status]} role="img">
      {entry.status === 'completed' ? (
        <Icon name="checkCircle" size={14} />
      ) : entry.status === 'in_progress' ? (
        <Icon name="circleDot" size={14} />
      ) : (
        <Icon name="circle" size={14} />
      )}
    </span>
    <span className="plan-text">{entry.content}</span>
    {entry.priority === 'high' && entry.status !== 'completed' && <Badge tone="warn">High</Badge>}
  </li>
);
