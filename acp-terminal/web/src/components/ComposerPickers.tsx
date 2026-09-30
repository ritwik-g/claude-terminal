import React, { useEffect, useRef, useState } from 'react';
import type { AcpSession, AgentDescriptor, ConfigChoice } from '../types';
import { api } from '../api';
import { useEscapeLayer } from '../hooks';
import { Badge, Icon, type IconName } from '../ui';
import { cx } from './sessionMeta';
import { formatWindow, sessionPricing } from '../pricing';
import {
  AUTO_EFFORT,
  advertisedFor,
  contextChoices,
  contextOfModel,
  effortLabel,
  modelChoices,
  sessionEffortChoices,
} from '../effort';

/**
 * The composer's approval and effort pickers: a pill that opens a short list of
 * choices above it (a bottom sheet on phones), in the style of the model switcher.
 */

function usePopover() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEscapeLayer(open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [open]);
  return { open, setOpen, rootRef };
}

interface PickRow {
  key: string;
  label: string;
  description?: string;
  icon?: IconName;
  badge?: string;
  selected: boolean;
  onSelect: () => void;
}

const PickList: React.FC<{ sections: Array<{ title?: string; rows: PickRow[] }>; label: string; onClose: () => void; className?: string }> = ({
  sections,
  label,
  onClose,
  className,
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  // Start on the current choice so arrow keys move from there
  useEffect(() => {
    const list = listRef.current;
    const target = list?.querySelector<HTMLButtonElement>('.pick-row.is-selected') || list?.querySelector<HTMLButtonElement>('.pick-row');
    target?.focus();
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('.pick-row') || []);
    const idx = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? Math.min(rows.length - 1, idx + 1) : e.key === 'ArrowUp' ? Math.max(0, idx - 1) : -1;
    if (next === -1) return;
    e.preventDefault();
    rows[next]?.focus();
  };
  return (
    <>
      <div className="ws-sheet-backdrop" onClick={onClose} aria-hidden />
      <div className={cx('ws-popover pick-popover', className)} role="dialog" aria-label={label} ref={listRef} onKeyDown={onKeyDown}>
        <div className="ws-sheet-handle" aria-hidden />
        {sections.map((section, i) => (
          <div key={section.title || i} className="pick-section" role="group" aria-label={section.title}>
            {section.title && <div className="pick-title">{section.title}</div>}
            {section.rows.map((row) => (
              <button
                key={row.key}
                type="button"
                role="menuitemradio"
                aria-checked={row.selected}
                className={cx('pick-row', row.selected && 'is-selected', row.description && 'has-desc')}
                onClick={row.onSelect}
              >
                {row.icon && <Icon name={row.icon} size={16} className="pick-icon" />}
                <span className="pick-text">
                  <span className="pick-label">
                    {row.label}
                    {row.badge && <Badge className="pick-badge">{row.badge}</Badge>}
                  </span>
                  {row.description && <span className="pick-desc">{row.description}</span>}
                </span>
                {row.selected && <Icon name="check" size={14} className="pick-check" />}
              </button>
            ))}
          </div>
        ))}
      </div>
    </>
  );
};

const PickPill: React.FC<{
  open: boolean;
  onToggle: () => void;
  icon?: IconName;
  title: string;
  /** The accessible name, where the visible text can be hidden (the approval pill on phones). */
  label?: string;
  className?: string;
  children: React.ReactNode;
}> = ({ open, onToggle, icon, title, label, className, children }) => (
  <button
    type="button"
    className={cx('pick-pill', open && 'is-open', className)}
    onClick={onToggle}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-label={label}
    title={title}
  >
    {icon && <Icon name={icon} size={14} />}
    <span className="pick-pill-text">{children}</span>
    <Icon name="chevronDown" size={12} className="pick-pill-chevron" />
  </button>
);

// ------------------------------------------------------------------ Approval

/** Plain names for the approval modes agents offer, by their kind (Claude and Codex share these). */
function describeMode(mode: ConfigChoice): { label: string; icon: IconName } {
  if (mode.kind === 'full_access') return { label: 'Full access', icon: 'unlock' };
  if (mode.kind === 'auto_review') return { label: 'Auto', icon: 'sparkles' };
  if (mode.kind === 'plan') return { label: 'Plan', icon: 'list' };
  if (mode.value === 'acceptEdits') return { label: 'Auto-accept edits', icon: 'edit' };
  if (mode.kind === 'standard') return { label: 'Supervised', icon: 'lock' };
  return { label: mode.label, icon: 'shield' };
}

const AUTO_APPROVE_DESC = 'CodePit answers every approval request with Allow.';

export const ApprovalPicker: React.FC<{ session: AcpSession; agents: AgentDescriptor[]; onChanged: () => void }> = ({
  session,
  agents,
  onChanged,
}) => {
  const { open, setOpen, rootRef } = usePopover();
  const agent = agents.find((a) => a.id === session.agentId);
  // The running agent's list, else what it offered last time, so the choice can be made before it starts
  const modes = session.agentOptions?.modes ?? advertisedFor(agent, session.model || agent?.defaultModel)?.modes ?? [];
  const autoApprove = Boolean(session.user.autoApprove);
  const currentMode = session.agentOptions?.currentMode ?? session.mode ?? modes[0]?.value;

  const run = async (fn: () => Promise<unknown>) => {
    setOpen(false);
    try {
      await fn();
    } catch (err: any) {
      alert(`Could not change approvals: ${err.message}`);
    } finally {
      onChanged();
    }
  };

  const rows: PickRow[] = modes.map((mode) => {
    const d = describeMode(mode);
    return {
      key: mode.value,
      label: d.label,
      icon: d.icon,
      description: mode.description,
      selected: !autoApprove && mode.value === currentMode,
      onSelect: () => run(() => api.setSessionMode(session.id, mode.value)),
    };
  });
  if (modes.length === 0) {
    rows.push({
      key: 'supervised',
      label: 'Supervised',
      icon: 'lock',
      description: 'Ask before commands and file changes.',
      selected: !autoApprove,
      onSelect: () => run(() => api.updateAnnotations(session.id, { autoApprove: false })),
    });
  }
  // This app's own auto-approve: for agents without a full-access mode, or while it is on
  if (autoApprove || !modes.some((m) => m.kind === 'full_access')) {
    rows.push({
      key: 'codepit-auto-approve',
      label: modes.length === 0 ? 'Full access' : 'Approve everything',
      icon: 'unlock',
      description: AUTO_APPROVE_DESC,
      selected: autoApprove,
      onSelect: () => run(() => api.updateAnnotations(session.id, { autoApprove: true })),
    });
  }
  const current = rows.find((r) => r.selected) ?? rows[0];

  return (
    <div className="pick-anchor" ref={rootRef}>
      <PickPill open={open} onToggle={() => setOpen(!open)} icon={current?.icon} title={`Approvals: ${current?.label}`} label={`Approvals: ${current?.label}`} className="pick-approval-pill">
        {current?.label}
      </PickPill>
      {open && <PickList label="Approvals" sections={[{ rows }]} onClose={() => setOpen(false)} className="pick-approval" />}
    </div>
  );
};

// ------------------------------------------------------------------ Effort, context, fast

export const EffortPicker: React.FC<{ session: AcpSession; agents: AgentDescriptor[]; onChanged: () => void }> = ({
  session,
  agents,
  onChanged,
}) => {
  const { open, setOpen, rootRef } = usePopover();
  const agent = agents.find((a) => a.id === session.agentId);
  const efforts = sessionEffortChoices(session, agents);
  const activeEffort = session.effort || AUTO_EFFORT;
  const opts = session.agentOptions;
  // The level the agent uses on Auto: the one it recommends, or the one it reports running on Auto
  // (Claude reports its "default" row there, which is not a level)
  const agentDefault = [opts?.recommendedEffort, activeEffort === AUTO_EFFORT ? opts?.currentEffort : undefined].find(
    (v) => v && efforts.some((e) => e.value === v)
  );
  const models = agent ? modelChoices(agent, opts) : [];
  const currentModel = opts?.currentModel ?? session.model;
  const contexts = contextChoices(models, currentModel);
  const fast = opts?.fast;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setOpen(false);
    try {
      await fn();
    } catch (err: any) {
      alert(`Could not change ${label}: ${err.message}`);
    } finally {
      onChanged();
    }
  };

  const sections: Array<{ title?: string; rows: PickRow[] }> = [];
  if (efforts.length > 0) {
    sections.push({
      title: 'Reasoning',
      rows: [
        {
          key: AUTO_EFFORT,
          label: 'Auto',
          description: agentDefault ? `The agent chooses; ${effortLabel(agentDefault, efforts)} now` : 'The agent chooses',
          selected: activeEffort === AUTO_EFFORT,
          onSelect: () => run('effort', () => api.setSessionEffort(session.id, AUTO_EFFORT)),
        },
        ...efforts.map((e) => ({
          key: e.value,
          label: effortLabel(e.value, efforts),
          badge: e.value === agentDefault ? 'Default' : undefined,
          selected: activeEffort === e.value,
          onSelect: () => run('effort', () => api.setSessionEffort(session.id, e.value)),
        })),
      ],
    });
  }
  if (contexts.length > 1) {
    sections.push({
      title: 'Context window',
      rows: contexts.map((c) => ({
        key: c.value,
        label: c.tokens ? formatWindow(c.tokens) : 'Standard',
        selected: c.value === currentModel,
        // A context size is its own model id to the agent ("opus[1m]"); the conversation is kept
        onSelect: () => run('the context window', () => api.setSessionAgent(session.id, session.agentId, c.value, session.effort, 'compact')),
      })),
    });
  }
  if (fast) {
    sections.push({
      title: 'Fast mode',
      rows: [
        { key: 'on', label: 'On', description: fast.description, selected: fast.enabled, onSelect: () => run('fast mode', () => api.setSessionFastMode(session.id, true)) },
        { key: 'off', label: 'Off', selected: !fast.enabled, onSelect: () => run('fast mode', () => api.setSessionFastMode(session.id, false)) },
      ],
    });
  }
  // Claude Code's keywords: ultrathink for one message, ultracode (models with Extra high) until turned off
  if (session.agentId === 'claude') {
    const rows: PickRow[] = [
      {
        key: 'ultrathink',
        label: 'Ultrathink',
        icon: 'brain',
        description: session.ultrathinkNext ? 'On for your next message' : 'Think hardest on your next message only',
        selected: Boolean(session.ultrathinkNext),
        onSelect: () => run('ultrathink', () => api.setSessionUltra(session.id, { ultrathinkNext: !session.ultrathinkNext })),
      },
    ];
    if (efforts.some((e) => e.value === 'xhigh')) {
      rows.push({
        key: 'ultracode',
        label: 'Ultracode',
        icon: 'layers',
        description: session.ultracode
          ? 'On for every message; click to turn off'
          : 'Plan and run multi-agent workflows on every message, at Extra high effort',
        selected: Boolean(session.ultracode),
        onSelect: () => run('ultracode', () => api.setSessionUltra(session.id, { ultracode: !session.ultracode })),
      });
    }
    sections.push({ title: 'Claude', rows });
  }
  if (sections.length === 0) return null;

  // The same window the context meter above uses
  const windowTokens = (currentModel && contextOfModel(currentModel)) || sessionPricing(session).contextWindow;
  const parts = [
    efforts.length > 0 ? effortLabel(activeEffort, efforts) : '',
    windowTokens ? formatWindow(windowTokens) : '',
    session.agentId === 'claude' && session.ultracode ? 'Ultracode' : '',
    session.agentId === 'claude' && session.ultrathinkNext ? 'Ultrathink' : '',
  ].filter(Boolean);

  return (
    <div className="pick-anchor" ref={rootRef}>
      <PickPill open={open} onToggle={() => setOpen(!open)} icon={fast?.enabled ? 'zap' : undefined} title="Reasoning effort, context window, fast mode, ultrathink and ultracode">
        {parts.join(' · ')}
      </PickPill>
      {open && <PickList label="Reasoning and context" sections={sections} onClose={() => setOpen(false)} className="pick-effort" />}
    </div>
  );
};
