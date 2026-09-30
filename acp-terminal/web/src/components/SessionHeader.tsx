import React, { useEffect, useRef, useState } from 'react';
import type { AcpSession, SessionMcpInfo } from '../types';
import { useEscapeLayer } from '../hooks';
import { Button, IconButton, Icon, Progress, StatusDot, Switch, Tabs, type Tone } from '../ui';
import { Menu, type MenuItem } from './Menu';
import { VendorIcon } from './VendorLogos';
import { cx, formatTokens, sessionStateView } from './sessionMeta';

export type WorkspaceTab = 'conversation' | 'agents' | 'terminal' | 'usage';

/** The session title, editable in place. Enter saves, Esc reverts. */
const TitleInput: React.FC<{
  session: AcpSession;
  onRename: (title: string) => Promise<boolean>;
  className: string;
}> = ({ session, onRename, className }) => {
  const [value, setValue] = useState(session.title);
  useEffect(() => setValue(session.title), [session.id, session.title]);

  const commit = async () => {
    const next = value.trim();
    // An empty title would leave the session unlabeled everywhere; revert instead.
    if (!next) {
      setValue(session.title);
      return;
    }
    if (next !== session.title && !(await onRename(next))) setValue(session.title);
  };

  return (
    <input
      className={className}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          // Blurring triggers onBlur → commit, so the rename is sent once.
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          setValue(session.title);
          e.currentTarget.blur();
        }
      }}
      placeholder="Untitled session"
      aria-label="Session title"
      spellCheck={false}
    />
  );
};

/** The score's parts; sessions ranked by an older server only have "label (+n)" strings. */
function rankFactors(session: AcpSession): Array<{ label: string; points: number }> {
  if (session.rankFactors?.length) return session.rankFactors;
  return session.reasons.map((r) => {
    const m = r.match(/^(.*?)\s*\(([+-]?\d+)\)$/);
    return m ? { label: m[1], points: Number(m[2]) } : { label: r, points: 0 };
  });
}

/** State label with a popover explaining the attention score. */
const StateButton: React.FC<{ session: AcpSession }> = ({ session }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const view = sessionStateView(session);
  useEscapeLayer(open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="ws-state" ref={rootRef}>
      <button
        type="button"
        className={cx('ws-state-btn', `tone-${view.tone}`)}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={session.rankSummary ? `${session.rankSummary} Click for details.` : 'Why this session ranks where it does'}
      >
        <StatusDot tone={view.tone} pulse={view.pulse} />
        {view.label}
      </button>
      {open && (
        <div className="ws-popover ws-reasons" role="dialog" aria-label="Why this session ranks here">
          <div className="ws-reasons-head">
            <span>Why it ranks here</span>
            <span className="ws-reasons-score" title="Attention score">
              Score {session.score}
            </span>
          </div>
          {session.rankSummary && <p className="ws-reasons-summary">{session.rankSummary}</p>}
          <ul className="ws-reasons-list" aria-label="What adds to the score">
            {rankFactors(session).map((f, i) => (
              <li key={i}>
                <span>{f.label}</span>
                {f.points !== 0 && (
                  <span className={cx('ws-reasons-points', f.points < 0 && 'is-down')}>
                    {f.points > 0 ? '+' : ''}
                    {f.points}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="ws-reasons-foot">
            The sidebar groups sessions by state and puts the highest score first in each group. Pin a session or give it a
            priority to move it up; snooze it to move it down.
          </p>
        </div>
      )}
    </div>
  );
};

/** How many app-level MCP servers the agent got at start, with the skipped ones in the tooltip. */
const McpChip: React.FC<{ mcp?: SessionMcpInfo; onOpen?: () => void }> = ({ mcp, onOpen }) => {
  if (!mcp || (mcp.attached.length === 0 && mcp.skipped.length === 0)) return null;
  const n = mcp.attached.length;
  const title = [
    n ? `MCP servers in this session: ${mcp.attached.join(', ')}` : 'No MCP servers in this session',
    ...mcp.skipped.map((s) => `Not given ${s.name}: ${s.reason}`),
  ].join('\n');
  const body = (
    <>
      <Icon name="plug" size={12} />
      <span>
        {n} MCP
        {mcp.skipped.length > 0 && <span className="ws-meta-warn">, {mcp.skipped.length} skipped</span>}
      </span>
    </>
  );
  // title is for pointer users; the sr-only copy gives keyboard and screen-reader users the same detail
  return onOpen ? (
    <button type="button" className="ws-meta ws-meta-btn" title={title} onClick={onOpen}>
      <span className="ws-meta-body" aria-hidden>{body}</span>
      <span className="sr-only">{title}. Open MCP settings.</span>
    </button>
  ) : (
    <span className="ws-meta" title={title}>
      <span className="ws-meta-body" aria-hidden>{body}</span>
      <span className="sr-only">{title}</span>
    </span>
  );
};

export const SessionHeader: React.FC<{
  session: AcpSession;
  onRename: (title: string) => Promise<boolean>;
  onToggleAutoApprove: () => void;
  onOpenSwitchModal: () => void;
  onStopAgent: () => void;
  onStartAgent: () => void;
  onTogglePriority: () => void;
  onTogglePin: () => void;
  menuItems: Array<MenuItem | 'divider'>;
  onBackToList?: () => void;
  totalSessionsCount?: number;
  onOpenMobileActions: () => void;
  onOpenMcp?: () => void;
}> = ({
  session,
  onRename,
  onToggleAutoApprove,
  onOpenSwitchModal,
  onStopAgent,
  onStartAgent,
  onTogglePriority,
  onTogglePin,
  menuItems,
  onBackToList,
  totalSessionsCount,
  onOpenMobileActions,
  onOpenMcp,
}) => {
  const folder = session.cwd.split('/').filter(Boolean).pop() || session.cwd;
  const dirty = session.git?.uncommittedFiles || 0;
  const priority = session.user.priority;
  const autoApprove = Boolean(session.user.autoApprove);

  return (
    <header className="ws-header">
      {onBackToList && (
        <button type="button" className="ws-back" onClick={onBackToList} aria-label="Back to all sessions" title="Back to all sessions">
          <Icon name="chevronLeft" size={18} />
          {totalSessionsCount !== undefined && totalSessionsCount > 0 && <span className="ws-back-count">{totalSessionsCount}</span>}
        </button>
      )}

      <span className="ws-vendor-mark" title={session.agentName}>
        <VendorIcon agentId={session.agentId} size={18} />
      </span>

      <div className="ws-title-block">
        <TitleInput session={session} onRename={onRename} className="ws-title-input" />
        <div className="ws-subline">
          <span className="ws-meta" title={session.cwd}>
            <Icon name="folder" size={12} />
            <span className="ws-meta-text">{folder}</span>
          </span>
          {session.git?.branch && (
            <span className="ws-meta" title={`Branch ${session.git.branch}`}>
              <Icon name="branch" size={12} />
              <span className="ws-meta-text mono">{session.git.branch}</span>
            </span>
          )}
          {dirty > 0 && (
            <span className="ws-meta is-dirty" title={`${dirty} uncommitted file${dirty === 1 ? '' : 's'}`}>
              <Icon name="diff" size={12} />
              {dirty} changed
            </span>
          )}
          <McpChip mcp={session.mcp} onOpen={onOpenMcp} />
          <StateButton session={session} />
        </div>
      </div>

      <div className="ws-header-actions">
        <div
          className={cx('ws-autoapprove', autoApprove && 'is-on')}
          title="Approve every permission request (file edits, commands) without asking"
        >
          <Switch
            checked={autoApprove}
            onChange={onToggleAutoApprove}
            label={
              <span className="ws-autoapprove-label">
                <Icon name="zap" size={13} />
                <span className="ws-autoapprove-text">Auto-approve</span>
              </span>
            }
          />
        </div>
        <Button variant="ghost" icon="swap" onClick={onOpenSwitchModal} title="Switch or fail over to another agent or model">
          Switch
        </Button>
        {session.isAgentRunning !== false ? (
          <Button
            variant="ghost"
            icon="stop"
            onClick={onStopAgent}
            title="Stop the agent process to free memory. History is kept; it restarts on your next message."
          >
            Stop agent
          </Button>
        ) : (
          <Button variant="ghost" icon="play" onClick={onStartAgent} title="Start the agent process again">
            Resume agent
          </Button>
        )}
        <span className="ws-sep" aria-hidden />
        <Button
          variant="ghost"
          icon="star"
          className={cx('ws-prio', priority && `is-${priority}`)}
          onClick={onTogglePriority}
          title={`Priority: ${priority ? priority.toUpperCase() : 'none'} (click or press p to cycle)`}
          aria-label={`Priority: ${priority ? priority.toUpperCase() : 'none'}`}
        >
          {priority ? priority.toUpperCase() : undefined}
        </Button>
        <IconButton
          icon="pin"
          label={session.user.pinned ? 'Unpin session' : 'Pin session to the top'}
          active={Boolean(session.user.pinned)}
          aria-pressed={Boolean(session.user.pinned)}
          onClick={onTogglePin}
        />
        <Menu label="More actions" items={menuItems} />
      </div>

      <div className="ws-header-mobile">
        <IconButton
          icon="zap"
          label={autoApprove ? 'Auto-approve on' : 'Auto-approve off'}
          active={autoApprove}
          tone="ok"
          aria-pressed={autoApprove}
          onClick={onToggleAutoApprove}
        />
        <IconButton icon="more" label="Session actions" onClick={onOpenMobileActions} />
      </div>
    </header>
  );
};

/** Tabs for the workspace body plus a compact context-window meter. */
export const SessionTabsBar: React.FC<{
  activeTab: WorkspaceTab;
  onChange: (tab: WorkspaceTab) => void;
  shellCommandCount: number;
  contextTokens: number;
  contextWindow: number;
  estimatedCost: number;
  /** Subagents, background work and workflows: how many, and how many still running. */
  agentTasks?: { total: number; running: number };
}> = ({ activeTab, onChange, shellCommandCount, contextTokens, contextWindow, estimatedCost, agentTasks }) => {
  const percent = Math.min(100, Math.round((contextTokens / contextWindow) * 100));
  const tone: Tone = percent > 80 ? 'danger' : percent > 50 ? 'warn' : 'accent';
  return (
    <div className="ws-tabs-bar">
      <Tabs<WorkspaceTab>
        label="Session views"
        value={activeTab}
        onChange={onChange}
        items={[
          { id: 'conversation', label: 'Conversation' },
          {
            id: 'agents',
            label: (
              <span className="agents-tab-label" title="Subagents, background commands and workflows">
                Agents
                {agentTasks && agentTasks.running > 0 && <StatusDot tone="accent" pulse label={`${agentTasks.running} running`} />}
              </span>
            ),
            count: agentTasks?.total,
          },
          { id: 'terminal', label: 'Terminal', count: shellCommandCount },
          { id: 'usage', label: 'Usage' },
        ]}
      />
      <button
        type="button"
        className={cx('ws-context-meter', `tone-${tone}`)}
        onClick={() => onChange('usage')}
        title={`Context window: ${contextTokens.toLocaleString()} of ${contextWindow.toLocaleString()} tokens (${percent}%). Estimated cost $${estimatedCost.toFixed(3)}. Click for the breakdown.`}
      >
        <span className="ws-context-label">Context</span>
        <span className="ws-context-bar">
          <Progress value={percent} tone={tone} size="sm" label="Context window used" />
        </span>
        <span className="ws-context-value">
          {formatTokens(contextTokens)} <span className="ws-context-max">/ {formatTokens(contextWindow)}</span>
        </span>
      </button>
    </div>
  );
};
