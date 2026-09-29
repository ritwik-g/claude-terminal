import React, { useState } from 'react';
import type { AcpSession, ToolCallRecord } from '../types';
import { Icon, Spinner } from './Icons';
import { commandOf, describeTool, isActive, subagentStatus } from '../toolDisplay';

/**
 * A strip above the conversation answering "what is going on right now?":
 * the agent's todo list, subagents still working, and commands running in the
 * foreground or background for the current request.
 */
export const ActivityStrip: React.FC<{ session: AcpSession }> = ({ session }) => {
  const [planOpen, setPlanOpen] = useState(false);
  const plan = session.plan || [];
  const done = plan.filter((p) => p.status === 'completed').length;
  const current = plan.find((p) => p.status === 'in_progress');

  // Only the current exchange: everything after the last user message.
  const lastUser = session.turns.map((t) => t.role).lastIndexOf('user');
  const recent = session.turns.slice(lastUser + 1).flatMap((t) => t.toolCalls || []);
  const all = session.turns.flatMap((t) => t.toolCalls || []);
  const childrenOf = (id: string) => all.filter((c) => c.parentToolUseId === id);

  const subagents = recent
    .filter((c) => c.isSubagent)
    .map((c) => ({ call: c, status: subagentStatus(c, childrenOf(c.id)) }))
    .filter((s) => s.status === 'running' || s.status === 'background');
  const commands = recent.filter(
    (c): c is ToolCallRecord => !c.isSubagent && !c.parentToolUseId && Boolean(commandOf(c)) && (isActive(c) || Boolean(c.background))
  );

  if (plan.length === 0 && subagents.length === 0 && commands.length === 0) return null;

  return (
    <div className="activity-strip">
      <div className="activity-strip-row">
        {plan.length > 0 && (
          <button type="button" className="strip-chip plan-chip" onClick={() => setPlanOpen(!planOpen)} aria-expanded={planOpen}>
            <Icon name="list" size={13} />
            <span className="strip-chip-label">Plan</span>
            <span className="plan-progress" aria-hidden>
              <span style={{ width: `${(done / plan.length) * 100}%` }} />
            </span>
            <span className="strip-chip-count">
              {done}/{plan.length}
            </span>
            {current && <span className="strip-chip-detail">{current.content}</span>}
            <Icon name={planOpen ? 'chevronDown' : 'chevronRight'} size={12} />
          </button>
        )}
        {subagents.map(({ call, status }) => (
          <span key={call.id} className="strip-chip" title={call.description || call.title}>
            <Spinner size={10} />
            <Icon name="bot" size={13} />
            <span className="strip-chip-detail">{call.description || describeTool(call).target}</span>
            {status === 'background' && <span className="strip-chip-tag">background</span>}
          </span>
        ))}
        {commands.map((call) => (
          <span key={call.id} className="strip-chip" title={commandOf(call)}>
            {isActive(call) ? <Spinner size={10} /> : <Icon name="clock" size={12} />}
            <Icon name="terminal" size={13} />
            <span className="strip-chip-detail mono">{commandOf(call)}</span>
            {call.background && <span className="strip-chip-tag">background</span>}
          </span>
        ))}
      </div>
      {planOpen && plan.length > 0 && (
        <ol className="plan-list">
          {plan.map((entry, i) => (
            <li key={i} className={`plan-item ${entry.status}`}>
              <span className="plan-check">
                {entry.status === 'completed' ? (
                  <Icon name="check" size={12} />
                ) : entry.status === 'in_progress' ? (
                  <Icon name="circleDot" size={12} />
                ) : (
                  <Icon name="circle" size={12} />
                )}
              </span>
              <span>{entry.content}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
};
