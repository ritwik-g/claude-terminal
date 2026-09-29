import React, { useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '../types';
import { VendorIcon } from './VendorLogos';
import { Badge, Button, Icon, IconButton, Input, Kbd, StatusDot, type Tone } from '../ui';
import { ThemeMenu } from './ThemeMenu';

// ------------------------------------------------------------------ helpers
// Shared by the sidebar, the command palette and the home dashboard.

/** Modifier key label for shortcuts: the Command glyph on Apple devices, Ctrl elsewhere. */
export const MOD_KEY =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';

export interface SessionStatus {
  label: string;
  tone: Tone;
  pulse: boolean;
}

/** Label and tone for a session's state, per the table in DESIGN.md. */
export function sessionStatus(s: Pick<SessionSummary, 'state' | 'isAgentRunning'>): SessionStatus {
  if (s.isAgentRunning === false && s.state !== 'crashed' && s.state !== 'blocked') {
    return { label: 'Agent stopped', tone: 'neutral', pulse: false };
  }
  switch (s.state) {
    case 'blocked':
      return { label: 'Needs approval', tone: 'danger', pulse: false };
    case 'needs_you':
      return { label: 'Your turn', tone: 'warn', pulse: false };
    case 'working':
      return { label: 'Working', tone: 'accent', pulse: true };
    case 'snoozed':
      return { label: 'Snoozed', tone: 'info', pulse: false };
    case 'crashed':
      return { label: 'Crashed', tone: 'danger', pulse: false };
    case 'parked':
      return { label: 'Parked', tone: 'neutral', pulse: false };
    default:
      return { label: 'Idle', tone: 'neutral', pulse: false };
  }
}

export const needsAttention = (s: SessionSummary) =>
  s.state === 'blocked' || s.state === 'needs_you' || s.state === 'crashed';

/** Previews are one line of plain text; drop markdown markers. */
export function plainText(md: string | undefined): string {
  return (md || '')
    .replace(/```[\w-]*/g, ' ')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function relativeTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export const folderName = (cwd: string) => cwd.split('/').filter(Boolean).pop() || cwd;

export const shortModel = (model?: string) => model?.replace(/^claude-/, '').replace(/^gemini-/, '');

/** The line under a session's title: the pending approval, else the recap or last prompt. */
export function sessionPreview(s: SessionSummary): { text: string; approval: boolean } {
  if (s.hasPendingPermission && s.pendingPermissionTitle) {
    return { text: `Approve: ${s.pendingPermissionTitle}`, approval: true };
  }
  return { text: plainText(s.recap || s.lastPrompt), approval: false };
}

const PRIORITY_TONE: Record<string, Tone> = { p0: 'danger', p1: 'warn', p2: 'neutral' };

export const PriorityBadge: React.FC<{ priority: SessionSummary['user']['priority'] }> = ({ priority }) =>
  priority ? (
    <Badge tone={PRIORITY_TONE[priority]} className="shell-prio" title={`Priority ${priority.toUpperCase()}`}>
      {priority.toUpperCase()}
    </Badge>
  ) : null;

/** Vendor mark, folder, branch and model. */
export const SessionMeta: React.FC<{ session: SessionSummary; showModel?: boolean }> = ({ session, showModel = true }) => {
  const model = shortModel(session.model);
  return (
    <span className="shell-meta">
      <VendorIcon agentId={session.agentId} size={12} />
      <span className="shell-meta-item" title={session.cwd}>
        {folderName(session.cwd)}
      </span>
      {session.git?.branch && (
        <span className="shell-meta-item" title={`Branch ${session.git.branch}`}>
          <Icon name="branch" size={11} />
          <span className="shell-meta-text">{session.git.branch}</span>
          {session.git.uncommittedFiles > 0 && (
            <span className="shell-meta-dirty" title={`${session.git.uncommittedFiles} uncommitted files`}>
              +{session.git.uncommittedFiles}
            </span>
          )}
        </span>
      )}
      {showModel && model && <span className="shell-meta-item mono shell-meta-model">{model}</span>}
    </span>
  );
};

// ------------------------------------------------------------------ sidebar

type FilterTab = 'all' | 'needs_you' | 'active' | 'cleanup';

interface SidebarProps {
  sessions: SessionSummary[];
  selectedId: string | null;
  onSelectSession: (id: string) => void;
  onGoHome: () => void;
  onOpenNewModal: () => void;
  onOpenPalette: () => void;
  onOpenSubscriptionsModal: () => void;
  onOpenNetworkModal: () => void;
  onOpenMcpModal: () => void;
  /** MCP servers switched on, shown next to the MCP entry. */
  mcpActiveCount: number;
  hasActiveSession?: boolean;
  activeSessionTitle?: string;
  onReturnToActiveSession?: () => void;
}

const GROUPS: Array<{ id: string; label: string; test: (s: SessionSummary) => boolean }> = [
  { id: 'needs_you', label: 'Needs you', test: needsAttention },
  { id: 'working', label: 'Working', test: (s) => s.state === 'working' },
  { id: 'parked', label: 'Parked', test: (s) => s.state === 'parked' },
  { id: 'quiet', label: 'Idle', test: (s) => s.state === 'quiet' },
  { id: 'snoozed', label: 'Snoozed', test: (s) => s.state === 'snoozed' },
];

export const Sidebar: React.FC<SidebarProps> = ({
  sessions,
  selectedId,
  onSelectSession,
  onGoHome,
  onOpenNewModal,
  onOpenPalette,
  onOpenSubscriptionsModal,
  onOpenNetworkModal,
  onOpenMcpModal,
  mcpActiveCount,
  hasActiveSession,
  activeSessionTitle,
  onReturnToActiveSession,
}) => {
  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterText, setFilterText] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (filterOpen) filterRef.current?.focus();
  }, [filterOpen]);

  const textFiltered = sessions.filter((s) => {
    if (!filterText) return true;
    const q = filterText.toLowerCase();
    return (
      s.title.toLowerCase().includes(q) ||
      s.cwd.toLowerCase().includes(q) ||
      s.agentName.toLowerCase().includes(q) ||
      Boolean(s.git?.branch && s.git.branch.toLowerCase().includes(q))
    );
  });

  // Tab counts come from the text-filtered set, so they stay put while switching tabs.
  const tabs: Array<{ id: FilterTab; label: string; test: (s: SessionSummary) => boolean }> = [
    { id: 'all', label: 'All', test: () => true },
    { id: 'needs_you', label: 'Needs you', test: needsAttention },
    { id: 'active', label: 'Active', test: (s) => needsAttention(s) || s.state === 'working' },
    { id: 'cleanup', label: 'Cleanup', test: (s) => s.user.cleanup },
  ];
  const activeTab = tabs.find((t) => t.id === filterTab)!;
  const filteredSessions = textFiltered.filter(activeTab.test);
  const groups = GROUPS.map((g) => ({ ...g, items: filteredSessions.filter(g.test) })).filter((g) => g.items.length > 0);
  const isHome = selectedId === null;

  return (
    <aside className="sidebar" aria-label="Sessions">
      <div className="sb-head">
        <button type="button" className="sb-brand" onClick={onGoHome} title="Home">
          <span className="sb-brand-mark" aria-hidden>
            <Icon name="terminal" size={13} />
          </span>
          <span className="sb-brand-name">ACP Terminal</span>
        </button>
        <div className="sb-head-actions">
          <IconButton
            icon="filter"
            label={filterOpen ? 'Hide the text filter' : 'Filter sessions by text'}
            size="sm"
            active={filterOpen || Boolean(filterText)}
            onClick={() => {
              if (filterOpen) setFilterText('');
              setFilterOpen(!filterOpen);
            }}
          />
          <span className="sb-head-mobile">
            <IconButton icon="search" label="Search and commands" onClick={onOpenPalette} />
            <Button variant="primary" size="sm" icon="plus" onClick={onOpenNewModal}>
              New
            </Button>
          </span>
        </div>
      </div>

      <nav className="sb-actions" aria-label="Workspace">
        <button type="button" className="sb-action" onClick={onOpenNewModal} title="Start a new agent session">
          <Icon name="plus" size={15} className="sb-action-icon" />
          <span className="sb-action-label">New session</span>
          <span className="sb-action-keys" aria-hidden>
            <Kbd>{MOD_KEY}</Kbd>
            <Kbd>N</Kbd>
          </span>
        </button>
        <button type="button" className="sb-action" onClick={onOpenPalette} title="Search sessions and run commands">
          <Icon name="search" size={15} className="sb-action-icon" />
          <span className="sb-action-label">Search</span>
          <span className="sb-action-keys" aria-hidden>
            <Kbd>{MOD_KEY}</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>
        <button
          type="button"
          className={`sb-action sb-action-home ${isHome ? 'is-current' : ''}`}
          onClick={onGoHome}
          aria-current={isHome ? 'page' : undefined}
        >
          <Icon name="home" size={15} className="sb-action-icon" />
          <span className="sb-action-label">Home</span>
        </button>
        <button
          type="button"
          className="sb-action"
          onClick={onOpenMcpModal}
          title="MCP servers your agents can use, and each agent's plugins and skills"
        >
          <Icon name="plug" size={15} className="sb-action-icon" />
          <span className="sb-action-label">MCP and plugins</span>
          {mcpActiveCount > 0 && (
            <span className="sb-action-count" aria-label={`${mcpActiveCount} MCP server${mcpActiveCount === 1 ? '' : 's'} on`}>
              {mcpActiveCount}
            </span>
          )}
        </button>
      </nav>

      <div className="sb-filters">
        <div className="sb-tabs" role="tablist" aria-label="Filter sessions">
          {tabs.map((t) => {
            const count = textFiltered.filter(t.test).length;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === filterTab}
                className={`sb-tab ${t.id === filterTab ? 'is-selected' : ''}`}
                onClick={() => setFilterTab(t.id)}
              >
                {t.label}
                {count > 0 && <span className={`sb-tab-count ${t.id === 'needs_you' ? 'is-alert' : ''}`}>{count}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {filterOpen && (
        <div className="sb-filter-input">
          <Input
            ref={filterRef}
            type="text"
            placeholder="Filter by title, folder, agent or branch"
            aria-label="Filter sessions by text"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setFilterText('');
                setFilterOpen(false);
              }
            }}
          />
        </div>
      )}

      {hasActiveSession && onReturnToActiveSession && (
        <button type="button" className="sb-return" onClick={onReturnToActiveSession}>
          <span className="sb-return-text">
            Back to <strong>{activeSessionTitle || 'the open session'}</strong>
          </span>
          <Icon name="chevronRight" size={15} />
        </button>
      )}

      <div className="sb-list">
        {groups.map((g) => (
          <section key={g.id} className="sb-group" aria-label={g.label}>
            <div className="sb-group-label">
              <span>{g.label}</span>
              <span className="sb-group-count">{g.items.length}</span>
            </div>
            {g.items.map((s) => (
              <SessionRow key={s.id} session={s} isSelected={s.id === selectedId} onSelect={() => onSelectSession(s.id)} />
            ))}
          </section>
        ))}

        {filteredSessions.length === 0 && (
          <div className="sb-list-empty">
            {sessions.length === 0 ? (
              <>
                <span>No sessions yet.</span>
                <Button variant="ghost" size="sm" icon="plus" onClick={onOpenNewModal}>
                  Start your first session
                </Button>
              </>
            ) : filterText ? (
              <span>No sessions match "{filterText}".</span>
            ) : (
              <span>Nothing here right now.</span>
            )}
          </div>
        )}
      </div>

      <div className="sb-foot">
        <button
          type="button"
          className="sb-foot-btn"
          data-testid="lan-access"
          onClick={onOpenNetworkModal}
          title="Open this workspace from another device on your network"
        >
          <Icon name="wifi" size={14} />
          <span>LAN access</span>
        </button>
        <div className="sb-foot-right">
          <ThemeMenu />
          <span className="sb-foot-mcp">
            <IconButton icon="plug" label="MCP and plugins" size="sm" onClick={onOpenMcpModal} />
            {mcpActiveCount > 0 && (
              <span className="sb-foot-mcp-count" aria-hidden>
                {mcpActiveCount}
              </span>
            )}
          </span>
          <IconButton
            icon="card"
            label="Subscriptions and usage"
            size="sm"
            onClick={onOpenSubscriptionsModal}
            title="Subscriptions, credentials and usage across vendors"
          />
        </div>
      </div>
    </aside>
  );
};

const SessionRow: React.FC<{
  session: SessionSummary;
  isSelected: boolean;
  onSelect: () => void;
}> = ({ session, isSelected, onSelect }) => {
  const status = sessionStatus(session);
  const preview = sessionPreview(session);

  return (
    <div
      className={`sb-row ${isSelected ? 'is-selected' : ''}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      role="button"
      tabIndex={0}
      aria-current={isSelected ? 'true' : undefined}
      data-session-id={session.id}
      title={session.reasons?.length ? `Ranking: ${session.reasons.join(' · ')}` : undefined}
    >
      <div className="sb-row-top">
        <span className="sb-row-dot" title={status.label}>
          <StatusDot tone={status.tone} pulse={status.pulse} label={status.label} />
        </span>
        <span className="sb-row-title">{session.title}</span>
        {session.user.pinned && (
          <span className="sb-row-pin" title="Pinned">
            <Icon name="pin" size={11} />
          </span>
        )}
        <PriorityBadge priority={session.user.priority} />
        <span className="sb-row-time" title={new Date(session.updatedAt).toLocaleString()}>
          {relativeTime(session.updatedAt)}
        </span>
      </div>
      <div className="sb-row-meta">
        <SessionMeta session={session} />
      </div>
      {preview.text && (
        <div className={`sb-row-preview ${preview.approval ? 'is-approval' : ''}`} title={preview.text}>
          {preview.text}
        </div>
      )}
    </div>
  );
};
