import React from 'react';
import type { AcpSession } from '../types';
import { Badge, Icon, IconButton, Switch, type IconName } from '../ui';
import { cx } from './sessionMeta';

const ActionRow: React.FC<{
  icon: IconName;
  label: string;
  description?: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  trailing?: React.ReactNode;
}> = ({ icon, label, description, onClick, disabled, danger, trailing }) => (
  <button type="button" className={cx('ws-sheet-row', danger && 'is-danger')} onClick={onClick} disabled={disabled}>
    <span className="ws-sheet-icon">
      <Icon name={icon} size={16} />
    </span>
    <span className="ws-sheet-text">
      <span className="ws-sheet-label">{label}</span>
      {description && <span className="ws-sheet-desc">{description}</span>}
    </span>
    {trailing ?? <Icon name="chevronRight" size={14} className="ws-sheet-chevron" />}
  </button>
);

const ToggleRow: React.FC<{
  icon: IconName;
  label: string;
  description: string;
  checked: boolean;
  onChange: () => void;
}> = ({ icon, label, description, checked, onChange }) => (
  <div className="ws-sheet-row is-toggle">
    <span className="ws-sheet-icon">
      <Icon name={icon} size={16} />
    </span>
    <Switch checked={checked} onChange={onChange} label={label} description={description} />
  </div>
);

/** The session's actions on small screens, as a bottom sheet. */
export const MobileActionSheet: React.FC<{
  session: AcpSession;
  modelLabel: string;
  isSnoozed: boolean;
  rollingBack: boolean;
  compacting: boolean;
  onClose: () => void;
  onToggleAutoApprove: () => void;
  onOpenModelPicker: () => void;
  onOpenSwitchModal: () => void;
  onUndoLast: () => void;
  onCompact: () => void;
  onTogglePriority: () => void;
  onTogglePin: () => void;
  onToggleCleanup: () => void;
  onToggleSnooze: () => void;
  onOpenSubscriptionsModal?: () => void;
  onOpenMcp?: () => void;
  onStopAgent: () => void;
  onStartAgent: () => void;
  onDelete: () => void;
}> = (p) => {
  const { session } = p;
  const running = session.isAgentRunning !== false;
  const then = (fn: () => void) => () => {
    p.onClose();
    fn();
  };

  return (
    <div className="ws-sheet-backdrop is-visible" onClick={p.onClose}>
      <div className="ws-sheet" role="dialog" aria-modal="true" aria-label="Session actions" onClick={(e) => e.stopPropagation()}>
        <div className="ws-sheet-handle" aria-hidden />
        <div className="ws-sheet-head">
          <div className="ws-sheet-title">
            <span className="ws-sheet-title-text">{session.title}</span>
            <span className="ws-sheet-subtitle">Session actions</span>
          </div>
          <IconButton icon="x" label="Close" onClick={p.onClose} />
        </div>

        <div className="ws-sheet-body">
          <div className="ws-sheet-group">
            <ToggleRow
              icon="zap"
              label="Auto-approve"
              description="Approve file edits and commands without asking"
              checked={Boolean(session.user.autoApprove)}
              onChange={p.onToggleAutoApprove}
            />
            <ToggleRow
              icon="pin"
              label="Pin to top"
              description="Keep this session at the top of the list"
              checked={Boolean(session.user.pinned)}
              onChange={p.onTogglePin}
            />
            <ToggleRow
              icon="moon"
              label="Snooze for 1 hour"
              description="Move it to the bottom of the list until later"
              checked={p.isSnoozed}
              onChange={p.onToggleSnooze}
            />
            <ToggleRow
              icon="check"
              label="Mark for cleanup"
              description="Filter finished work out of the active queue"
              checked={Boolean(session.user.cleanup)}
              onChange={p.onToggleCleanup}
            />
            <ActionRow
              icon="star"
              label="Priority"
              description="Tap to cycle P0, P1, P2 and none"
              onClick={p.onTogglePriority}
              trailing={
                <Badge tone={session.user.priority ? 'warn' : 'neutral'}>
                  {session.user.priority ? session.user.priority.toUpperCase() : 'None'}
                </Badge>
              }
            />
          </div>

          <div className="ws-sheet-group">
            <ActionRow icon="brain" label="Model and effort" description={p.modelLabel} onClick={then(p.onOpenModelPicker)} />
            <ActionRow icon="swap" label="Switch agent" description="Fail over to another agent, or fork the session" onClick={then(p.onOpenSwitchModal)} />
            <ActionRow
              icon="undo"
              label="Undo last turn"
              description="Revert the last message and response"
              onClick={then(p.onUndoLast)}
              disabled={session.turns.length === 0 || p.rollingBack}
            />
            <ActionRow
              icon="archive"
              label={p.compacting ? 'Compacting…' : 'Compact context'}
              description="Summarise earlier turns to free up context"
              onClick={then(p.onCompact)}
              disabled={session.turns.length <= 1 || p.compacting}
            />
            {p.onOpenSubscriptionsModal && (
              <ActionRow icon="card" label="Subscriptions and usage" description="Vendor limits, keys and token usage" onClick={then(p.onOpenSubscriptionsModal)} />
            )}
            {p.onOpenMcp && (
              <ActionRow
                icon="plug"
                label="MCP and plugins"
                description={session.mcp?.attached.length ? `${session.mcp.attached.length} MCP server${session.mcp.attached.length === 1 ? '' : 's'} in this session` : 'Tools your agents can use'}
                onClick={then(p.onOpenMcp)}
              />
            )}
          </div>

          <div className="ws-sheet-group">
            <ActionRow
              icon={running ? 'stop' : 'play'}
              label={running ? 'Stop agent' : 'Resume agent'}
              description={running ? 'Free memory; history is kept and it restarts on your next message' : 'Start the agent process again'}
              onClick={then(running ? p.onStopAgent : p.onStartAgent)}
            />
            <ActionRow icon="trash" label="Delete session" description="Stop the agent and remove its history" onClick={then(p.onDelete)} danger />
          </div>
        </div>
      </div>
    </div>
  );
};
