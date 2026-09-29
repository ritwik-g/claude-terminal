import React, { useState } from 'react';
import type { SessionSummary } from '../types';
import { VendorIcon } from './VendorLogos';

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

  const filteredSessions = sessions.filter((s) => {
    // Text search filter
    if (filterText) {
      const q = filterText.toLowerCase();
      const match =
        s.title.toLowerCase().includes(q) ||
        s.cwd.toLowerCase().includes(q) ||
        s.agentName.toLowerCase().includes(q) ||
        (s.git?.branch && s.git.branch.toLowerCase().includes(q));
      if (!match) return false;
    }

    // Tab filter
    if (filterTab === 'active') {
      return s.state === 'working' || s.state === 'blocked' || s.state === 'needs_you';
    }
    if (filterTab === 'needs_you') {
      return s.state === 'blocked' || s.state === 'needs_you';
    }
    if (filterTab === 'cleanup') {
      return s.user.cleanup;
    }
    return true;
  });

  // Group sessions by attention buckets
  const groups = {
    needs_you: filteredSessions.filter((s) => s.state === 'blocked' || s.state === 'needs_you' || s.state === 'crashed'),
    working: filteredSessions.filter((s) => s.state === 'working'),
    parked: filteredSessions.filter((s) => s.state === 'parked'),
    quiet: filteredSessions.filter((s) => s.state === 'quiet'),
    snoozed: filteredSessions.filter((s) => s.state === 'snoozed'),
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="brand-title">
          <span style={{ fontSize: '18px' }}>⚡</span>
          <span>ACP Terminal</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <button
            type="button"
            className="btn-subscriptions-nav"
            onClick={onOpenSubscriptionsModal}
            title="Inspect subscriptions, change auth credentials & view cross-vendor usage"
          >
            💳 Subscriptions
          </button>
          <button className="btn-new" onClick={onOpenNewModal} title="Start new agent session">
            <span>+</span> New
          </button>
        </div>
      </div>

      <div className="sidebar-search">
        <input
          type="text"
          className="search-input"
          placeholder="Filter sessions... (press / to search)"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
      </div>

      <div className="filter-tabs">
        <button
          className={`filter-tab ${filterTab === 'all' ? 'active' : ''}`}
          onClick={() => setFilterTab('all')}
        >
          All ({sessions.length})
        </button>
        <button
          className={`filter-tab ${filterTab === 'needs_you' ? 'active' : ''}`}
          onClick={() => setFilterTab('needs_you')}
        >
          Needs You ({groups.needs_you.length})
        </button>
        <button
          className={`filter-tab ${filterTab === 'active' ? 'active' : ''}`}
          onClick={() => setFilterTab('active')}
        >
          Active ({groups.needs_you.length + groups.working.length})
        </button>
        <button
          className={`filter-tab ${filterTab === 'cleanup' ? 'active' : ''}`}
          onClick={() => setFilterTab('cleanup')}
        >
          Cleanup
        </button>
      </div>

      {hasActiveSession && onReturnToActiveSession && (
        <div className="mobile-active-session-banner" onClick={onReturnToActiveSession}>
          <span>💬 Return to: <strong>{activeSessionTitle || 'Active Chat'}</strong></span>
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
            No sessions match the filter.
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
          <span>📡</span> LAN Access
        </button>
        <button
          type="button"
          className="btn-sidebar-footer"
          onClick={onOpenSearchModal}
          title="Search all sessions (press /)"
        >
          <span>🔍</span> Search (/)
        </button>
      </div>
    </aside>
  );
};

const SessionCard: React.FC<{
  session: SessionSummary;
  isSelected: boolean;
  onSelect: () => void;
}> = ({ session, isSelected, onSelect }) => {
  const agentClass = session.agentId.toLowerCase().includes('claude')
    ? 'claude'
    : session.agentId.toLowerCase().includes('codex')
    ? 'codex'
    : (session.agentId.toLowerCase().includes('gemini') || session.agentId.toLowerCase().includes('antigravity'))
    ? 'gemini'
    : 'mock';

  const folderName = session.cwd.split('/').filter(Boolean).pop() || session.cwd;

  return (
    <div
      className={`session-card ${session.state} ${isSelected ? 'active' : ''}`}
      onClick={onSelect}
    >
      <div className="session-card-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <VendorIcon agentId={session.agentId} size={15} />
          <span className={`agent-badge ${agentClass}`}>{session.agentName.split(' ')[0]}</span>
          {session.model && (
            <span className="sidebar-model-badge" title={`Model: ${session.model}`}>
              {session.model.replace(/^claude-/, '').replace(/^gemini-/, '')}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          {session.user.pinned && <span title="Pinned">📌</span>}
          {session.user.priority && (
            <span
              style={{
                fontSize: '10px',
                fontWeight: 700,
                color: session.user.priority === 'p0' ? '#ef4444' : '#f59e0b',
              }}
            >
              {session.user.priority.toUpperCase()}
            </span>
          )}
          <span className={`state-badge ${session.state}`}>
            {session.state === 'blocked' ? '⚠️ APPROVAL' : session.state.replace('_', ' ').toUpperCase()}
          </span>
        </div>
      </div>

      <div className="session-title" title={session.title}>
        {session.title}
      </div>

      <div className="session-meta">
        <span title={session.cwd}>{folderName}</span>
        {session.git?.branch && <span className="branch-tag">{session.git.branch}</span>}
        {session.git && session.git.uncommittedFiles > 0 && (
          <span className="git-dirty-tag">+{session.git.uncommittedFiles} dirty</span>
        )}
        {session.tokenCount > 0 && (
          <span style={{ marginLeft: 'auto' }}>
            {Math.round(session.tokenCount / 1000)}k
          </span>
        )}
      </div>

      {session.reasons && session.reasons.length > 0 && (
        <div className="reasons-hint" title={session.reasons.join(' | ')}>
          {session.reasons[session.reasons.length - 1]}
        </div>
      )}
    </div>
  );
};
