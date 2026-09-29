import React, { useState } from 'react';
import type { SessionSummary } from '../types';
import { VendorIcon } from './VendorLogos';
import { Icon } from './Icons';

interface SidebarProps {
  sessions: SessionSummary[];
  selectedId: string | null;
  onSelectSession: (id: string) => void;
  onOpenNewModal: () => void;
  onOpenSearchModal: () => void;
  onOpenSubscriptionsModal: () => void;
  onOpenNetworkModal: () => void;
  hasActiveSession?: boolean;
  activeSessionTitle?: string;
  onReturnToActiveSession?: () => void;
}

const needsYou = (s: SessionSummary) => s.state === 'blocked' || s.state === 'needs_you' || s.state === 'crashed';

export const Sidebar: React.FC<SidebarProps> = ({
  sessions,
  selectedId,
  onSelectSession,
  onOpenNewModal,
  onOpenSearchModal,
  onOpenSubscriptionsModal,
  onOpenNetworkModal,
  hasActiveSession,
  activeSessionTitle,
  onReturnToActiveSession,
}) => {
  const [filterTab, setFilterTab] = useState<'all' | 'active' | 'needs_you' | 'cleanup'>('all');
  const [filterText, setFilterText] = useState('');

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
  const tabCounts = {
    all: textFiltered.length,
    needs_you: textFiltered.filter(needsYou).length,
    active: textFiltered.filter((s) => needsYou(s) || s.state === 'working').length,
    cleanup: textFiltered.filter((s) => s.user.cleanup).length,
  };

  const filteredSessions = textFiltered.filter((s) => {
    if (filterTab === 'active') return needsYou(s) || s.state === 'working';
    if (filterTab === 'needs_you') return needsYou(s);
    if (filterTab === 'cleanup') return s.user.cleanup;
    return true;
  });

  // Group sessions by attention buckets
  const groups = {
    needs_you: filteredSessions.filter(needsYou),
    working: filteredSessions.filter((s) => s.state === 'working'),
    parked: filteredSessions.filter((s) => s.state === 'parked'),
    quiet: filteredSessions.filter((s) => s.state === 'quiet'),
    snoozed: filteredSessions.filter((s) => s.state === 'snoozed'),
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="brand-title">
          <span className="brand-mark">
            <Icon name="terminal" size={14} />
          </span>
          <span>ACP Terminal</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <button
            type="button"
            className="hbtn icon"
            onClick={onOpenSubscriptionsModal}
            title="Subscriptions, credentials and usage across vendors"
            aria-label="Subscriptions and usage"
          >
            <Icon name="card" size={15} />
          </button>
          <button className="btn-new" onClick={onOpenNewModal} title="Start a new agent session (⌘N)">
            <Icon name="plus" size={14} /> New
          </button>
        </div>
      </div>

      <div className="sidebar-search">
        <input
          type="text"
          className="search-input"
          placeholder="Filter by title, folder, agent or branch…"
          aria-label="Filter sessions"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
      </div>

      <div className="filter-tabs">
        <button
          className={`filter-tab ${filterTab === 'all' ? 'active' : ''}`}
          onClick={() => setFilterTab('all')}
        >
          All ({tabCounts.all})
        </button>
        <button
          className={`filter-tab ${filterTab === 'needs_you' ? 'active' : ''}`}
          onClick={() => setFilterTab('needs_you')}
        >
          Needs You ({tabCounts.needs_you})
        </button>
        <button
          className={`filter-tab ${filterTab === 'active' ? 'active' : ''}`}
          onClick={() => setFilterTab('active')}
        >
          Active ({tabCounts.active})
        </button>
        <button
          className={`filter-tab ${filterTab === 'cleanup' ? 'active' : ''}`}
          onClick={() => setFilterTab('cleanup')}
        >
          Cleanup{tabCounts.cleanup > 0 ? ` (${tabCounts.cleanup})` : ''}
        </button>
      </div>

      {hasActiveSession && onReturnToActiveSession && (
        <div className="mobile-active-session-banner" onClick={onReturnToActiveSession}>
          <span>Back to <strong>{activeSessionTitle || "the open session"}</strong></span>
          <span className="banner-arrow">→</span>
        </div>
      )}

      <div className="sessions-list">
        {/* Needs You Group */}
        {groups.needs_you.length > 0 && (
          <div className="session-group">
            <div className="group-header">
              <span>Needs You</span>
              <span>{groups.needs_you.length}</span>
            </div>
            {groups.needs_you.map((s) => (
              <SessionCard
                key={s.id}
                session={s}
                isSelected={s.id === selectedId}
                onSelect={() => onSelectSession(s.id)}
              />
            ))}
          </div>
        )}

        {/* Working Group */}
        {groups.working.length > 0 && (
          <div className="session-group">
            <div className="group-header">
              <span>Working</span>
              <span>{groups.working.length}</span>
            </div>
            {groups.working.map((s) => (
              <SessionCard
                key={s.id}
                session={s}
                isSelected={s.id === selectedId}
                onSelect={() => onSelectSession(s.id)}
              />
            ))}
          </div>
        )}

        {/* Parked Group */}
        {groups.parked.length > 0 && (
          <div className="session-group">
            <div className="group-header">
              <span>Parked (Work left behind)</span>
              <span>{groups.parked.length}</span>
            </div>
            {groups.parked.map((s) => (
              <SessionCard
                key={s.id}
                session={s}
                isSelected={s.id === selectedId}
                onSelect={() => onSelectSession(s.id)}
              />
            ))}
          </div>
        )}

        {/* Quiet Group */}
        {groups.quiet.length > 0 && (
          <div className="session-group">
            <div className="group-header">
              <span>Quiet</span>
              <span>{groups.quiet.length}</span>
            </div>
            {groups.quiet.map((s) => (
              <SessionCard
                key={s.id}
                session={s}
                isSelected={s.id === selectedId}
                onSelect={() => onSelectSession(s.id)}
              />
            ))}
          </div>
        )}

        {/* Snoozed Group */}
        {groups.snoozed.length > 0 && (
          <div className="session-group">
            <div className="group-header">
              <span>Snoozed</span>
              <span>{groups.snoozed.length}</span>
            </div>
            {groups.snoozed.map((s) => (
              <SessionCard
                key={s.id}
                session={s}
                isSelected={s.id === selectedId}
                onSelect={() => onSelectSession(s.id)}
              />
            ))}
          </div>
        )}

        {filteredSessions.length === 0 && (
          <div style={{ padding: '30px 16px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '13px' }}>
            {sessions.length === 0 ? (
              <>
                No sessions yet.
                <br />
                <button type="button" className="btn-link" onClick={onOpenNewModal}>
                  Start your first agent session
                </button>
              </>
            ) : filterText ? (
              <>No sessions match “{filterText}”.</>
            ) : (
              <>Nothing in this tab right now.</>
            )}
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        <button
          type="button"
          className="btn-sidebar-footer btn-lan-access"
          onClick={onOpenNetworkModal}
          title="View Local Network (LAN) URL & Token to connect from other devices"
        >
          <Icon name="wifi" size={14} /> LAN access
        </button>
        <button
          type="button"
          className="btn-sidebar-footer"
          onClick={onOpenSearchModal}
          title="Search all sessions (press /)"
        >
          <Icon name="search" size={14} /> Search <kbd className="kbd">/</kbd>
        </button>
      </div>
    </aside>
  );
};

const STATE_LABEL: Record<string, string> = {
  blocked: 'Needs approval',
  needs_you: 'Your turn',
  working: 'Working',
  parked: 'Parked',
  quiet: 'Idle',
  snoozed: 'Snoozed',
  crashed: 'Crashed',
};

/** Card previews are one line of plain text; drop markdown markers. */
function plainText(md: string | undefined): string {
  return (md || '')
    .replace(/```[\w-]*/g, ' ')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function relativeTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

const SessionCard: React.FC<{
  session: SessionSummary;
  isSelected: boolean;
  onSelect: () => void;
}> = ({ session, isSelected, onSelect }) => {
  const folderName = session.cwd.split('/').filter(Boolean).pop() || session.cwd;
  const model = session.model?.replace(/^claude-/, '').replace(/^gemini-/, '');
  const detail =
    session.hasPendingPermission && session.pendingPermissionTitle
      ? session.pendingPermissionTitle
      : plainText(session.recap || session.lastPrompt);

  return (
    <div
      className={`session-card ${session.state} ${isSelected ? 'active' : ''}`}
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
      <div className="card-row">
        <span className={`state-dot dot-${session.state}`} aria-label={STATE_LABEL[session.state] || session.state} />
        <span className="session-title">{session.title}</span>
        {session.user.pinned && <Icon name="pin" size={12} className="card-pin" title="Pinned" />}
        {session.user.priority && <span className={`prio prio-${session.user.priority}`}>{session.user.priority.toUpperCase()}</span>}
        <span className="card-time" title={new Date(session.updatedAt).toLocaleString()}>
          {relativeTime(session.updatedAt)}
        </span>
      </div>
      <div className="card-meta">
        <VendorIcon agentId={session.agentId} size={12} />
        <span className="card-meta-item" title={session.cwd}>{folderName}</span>
        {session.git?.branch && (
          <span className="card-meta-item">
            <Icon name="branch" size={11} /> {session.git.branch}
            {session.git.uncommittedFiles > 0 && <span className="git-dirty-tag"> +{session.git.uncommittedFiles}</span>}
          </span>
        )}
        {model && <span className="card-meta-item card-model">{model}</span>}
      </div>
      {detail && (
        <div className={`card-detail ${session.hasPendingPermission ? 'approval' : ''}`} title={detail}>
          {session.hasPendingPermission ? `Approve: ${detail}` : detail}
        </div>
      )}
    </div>
  );
};
