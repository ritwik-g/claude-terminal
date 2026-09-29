import React, { useState, useEffect, useCallback } from 'react';
import type { AcpSession, AgentDescriptor, SessionSummary } from './types';
import { api, connectWebSocket } from './api';
import { Sidebar } from './components/Sidebar';
import { SessionDetail, nextPriority } from './components/SessionDetail';
import { NewSessionModal } from './components/NewSessionModal';
import { SwitchAgentModal } from './components/SwitchAgentModal';
import { SearchModal } from './components/SearchModal';
import { SubscriptionsUsageModal } from './components/SubscriptionsUsageModal';
import { NetworkModal } from './components/NetworkModal';
import { ErrorBoundary } from './components/ErrorBoundary';

/** Session ids in the order the sidebar shows them, honouring its filters and grouping. */
function visibleSessionOrder(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.sidebar [data-session-id]')).map(
    (el) => el.dataset.sessionId!
  );
}

export const App: React.FC = () => {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [agents, setAgents] = useState<AgentDescriptor[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<AcpSession | null>(null);
  const [showNewModal, setShowNewModal] = useState(false);
  const [showSwitchModal, setShowSwitchModal] = useState(false);
  const [showSearchModal, setShowSearchModal] = useState(false);
  const [showSubscriptionsModal, setShowSubscriptionsModal] = useState(false);
  const [showNetworkModal, setShowNetworkModal] = useState(false);
  const [authError, setAuthError] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  // Start on the list: with nothing selected yet, the session pane on mobile is a dead end.
  const [mobileView, setMobileView] = useState<'list' | 'session'>('list');
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await api.getSessions();
      setSessions(res.sessions);
      setAuthError(false);
      setOffline(false);
      if (selectedId && !res.sessions.some((s) => s.id === selectedId)) {
        // The open session was deleted (here or from another tab/device).
        setSelectedId(res.sessions[0]?.id ?? null);
      } else if (!selectedId && res.sessions.length > 0) {
        setSelectedId(res.sessions[0].id);
      } else if (selectedId) {
        const match = res.sessions.find((s) => s.id === selectedId);
        if (match) {
          setActiveSession((prev) => {
            if (!prev || prev.id !== selectedId) return prev;
            if (prev.state !== match.state) {
              return { ...prev, state: match.state };
            }
            return prev;
          });
        }
      }
    } catch (err: any) {
      console.error('[App] Failed to fetch sessions:', err);
      if (err.message?.includes('401') || err.message?.includes('Unauthorized')) {
        setAuthError(true);
      } else {
        setOffline(true);
      }
    }
  }, [selectedId]);

  const fetchSessionDetail = useCallback(async (id: string) => {
    try {
      const res = await api.getSession(id);
      setActiveSession(res.session);
    } catch (err: any) {
      console.error(`[App] Failed to fetch session detail for ${id}:`, err);
      if (err.message?.includes('401') || err.message?.includes('Unauthorized')) {
        setAuthError(true);
      }
    }
  }, []);

  const handleManualTokenSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!tokenInput.trim()) return;
    sessionStorage.setItem('acp_token', tokenInput.trim());
    window.location.search = `?token=${encodeURIComponent(tokenInput.trim())}`;
  };

  // Initial load
  useEffect(() => {
    Promise.all([
      api.getAgents().then((res) => setAgents(res.agents)).catch((err) => {
        if (err.message?.includes('401') || err.message?.includes('Unauthorized')) setAuthError(true);
      }),
      fetchSessions(),
    ]).finally(() => setLoading(false));
  }, [fetchSessions]);

  // Load session detail on selection change
  useEffect(() => {
    if (selectedId) {
      fetchSessionDetail(selectedId);
    } else {
      setActiveSession(null);
    }
  }, [selectedId, fetchSessionDetail]);

  // Periodic background check to prevent state drift
  useEffect(() => {
    const interval = setInterval(() => {
      fetchSessions();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchSessions]);

  // WebSocket reactive updates
  useEffect(() => {
    let wasOffline = false;
    const ws = connectWebSocket((msg) => {
      if (msg.type === 'sessionsUpdated' && Array.isArray(msg.sessions)) {
        setSessions(msg.sessions);
        if (selectedId) {
          const match = msg.sessions.find((s: SessionSummary) => s.id === selectedId);
          if (!match) {
            setSelectedId(msg.sessions[0]?.id ?? null);
          } else {
            setActiveSession((prev) => {
              if (!prev || prev.id !== selectedId) return prev;
              if (prev.state !== match.state) {
                return { ...prev, state: match.state };
              }
              return prev;
            });
          }
        }
      } else if (msg.type === 'sessionStream' || ['thought', 'message', 'toolCall', 'toolCallUpdate', 'turnCompleted'].includes(msg.type)) {
        if (selectedId && msg.sessionId === selectedId) {
          if (msg.session) {
            setActiveSession((prev) => (prev && prev.id === selectedId ? { ...prev, ...msg.session } : prev));
          }
          if (msg.turn) {
            setActiveSession((prev) => {
              if (!prev || prev.id !== msg.sessionId) return prev;
              const turns = [...prev.turns];
              const idx = turns.findIndex((t) => t.id === msg.turn.id);
              if (idx !== -1) {
                turns[idx] = { ...turns[idx], ...msg.turn };
              } else {
                turns.push(msg.turn);
              }
              return { ...prev, turns };
            });
          }
          if (msg.event === 'rateLimits' || msg.rateLimits) {
            setActiveSession((prev) => (prev && prev.id === selectedId ? { ...prev, rateLimits: msg.rateLimits || prev.rateLimits } : prev));
          }
          if (msg.event === 'promptSuggestion' || msg.promptSuggestion) {
            setActiveSession((prev) => (prev && prev.id === selectedId ? { ...prev, promptSuggestion: msg.promptSuggestion || prev.promptSuggestion } : prev));
          }
          if (['thought', 'message', 'toolCall', 'toolCallUpdate'].includes(msg.event || msg.type)) {
            setActiveSession((prev) => (prev && prev.id === selectedId && prev.state !== 'working' ? { ...prev, state: 'working' } : prev));
          }
          if (['turnCompleted', 'sessionStopped', 'sessionStarted', 'sessionSwitched', 'sessionCompacted', 'sessionRollback'].includes(msg.event || msg.type)) {
            if (msg.event === 'turnCompleted' || msg.type === 'turnCompleted') {
              setActiveSession((prev) => (prev && prev.id === selectedId ? { ...prev, state: 'needs_you' } : prev));
            }
            fetchSessionDetail(selectedId);
            fetchSessions();
          }
        }
      } else if (msg.type === 'permissionRequested' || msg.type === 'permissionResolved') {
        if (selectedId && msg.sessionId === selectedId) {
          fetchSessionDetail(selectedId);
          fetchSessions();
        }
      }
    }, () => {
      // Reconnected: resync everything streamed while the socket was down.
      if (wasOffline) {
        wasOffline = false;
        setOffline(false);
        fetchSessions();
        if (selectedId) fetchSessionDetail(selectedId);
      }
    }, () => {
      wasOffline = true;
      setOffline(true);
    });

    return () => {
      ws.close();
    };
  }, [selectedId, fetchSessionDetail, fetchSessions]);

  const anyModalOpen =
    showNewModal || showSwitchModal || showSearchModal || showSubscriptionsModal || showNetworkModal;

  const handleDeleted = useCallback(
    (deletedId: string) => {
      // Move to the neighbouring session in sidebar order rather than leaving the
      // deleted one on screen.
      const order = visibleSessionOrder();
      const idx = order.indexOf(deletedId);
      const remaining = order.filter((id) => id !== deletedId);
      const next = remaining[Math.min(Math.max(idx, 0), remaining.length - 1)] ?? null;
      setSelectedId(next);
      if (!next) {
        setActiveSession(null);
        setMobileView('list');
      }
      fetchSessions();
    },
    [fetchSessions]
  );

  // Keyboard navigation shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Esc must close a modal even while focus is in one of its inputs.
        setShowNewModal(false);
        setShowSwitchModal(false);
        setShowSearchModal(false);
        setShowSubscriptionsModal(false);
        setShowNetworkModal(false);
        return;
      }

      if (e.key.toLowerCase() === 'n' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setShowNewModal(true);
        return;
      }

      // Everything below is a bare single-key shortcut: never steal Cmd/Ctrl/Alt
      // combos (Cmd+C must copy, not toggle cleanup), typing, or keys meant for a modal.
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) return;
      if (target?.closest?.('.xterm')) return;
      if (anyModalOpen) return;

      if (e.key === '/') {
        e.preventDefault();
        setShowSearchModal(true);
      } else if (['j', 'k', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
        // Arrows navigate only from the page or the sidebar, so they still scroll
        // the conversation when it has focus.
        const isArrow = e.key.startsWith('Arrow');
        if (isArrow && target !== document.body && !target?.closest?.('.sidebar')) return;
        e.preventDefault();
        const order = visibleSessionOrder();
        if (order.length === 0) return;
        const idx = selectedId ? order.indexOf(selectedId) : -1;
        const nextIdx =
          e.key === 'j' || e.key === 'ArrowDown'
            ? idx === -1 || idx === order.length - 1 ? 0 : idx + 1
            : idx <= 0 ? order.length - 1 : idx - 1;
        const nextId = order[nextIdx];
        setSelectedId(nextId);
        document.querySelector(`[data-session-id="${CSS.escape(nextId)}"]`)?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && selectedId) {
        setMobileView('session');
      } else if (e.key === 'p' && selectedId && activeSession) {
        api
          .updateAnnotations(selectedId, { priority: nextPriority(activeSession.user.priority) })
          .then(() => {
            fetchSessions();
            fetchSessionDetail(selectedId);
          })
          .catch((err) => alert(`Could not update priority: ${err.message}`));
      } else if (e.key === 'c' && selectedId && activeSession) {
        api
          .updateAnnotations(selectedId, { cleanup: !activeSession.user.cleanup })
          .then(() => {
            fetchSessions();
            fetchSessionDetail(selectedId);
          })
          .catch((err) => alert(`Could not update cleanup mark: ${err.message}`));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedId, activeSession, anyModalOpen, fetchSessions, fetchSessionDetail]);

  if (authError && sessions.length === 0) {
    return (
      <div className="auth-required-screen">
        <div className="auth-card">
          <div className="auth-icon">🔐</div>
          <h2>Authentication Required</h2>
          <p>
            You are connecting to ACP Terminal from another device on your network (<code>{window.location.host}</code>).
          </p>
          <p className="auth-hint">
            Please enter the security token from your host computer:
          </p>
          <form onSubmit={handleManualTokenSubmit}>
            <input
              type="text"
              className="auth-token-input"
              placeholder="Paste security token here..."
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              autoFocus
            />
            <button type="submit" className="btn-send" style={{ width: '100%', padding: '10px' }} disabled={!tokenInput.trim()}>
              Connect to ACP Terminal
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className={`app-container mobile-view-${mobileView}`}>
      <Sidebar
        sessions={sessions}
        selectedId={selectedId}
        onSelectSession={(id) => {
          setSelectedId(id);
          setMobileView('session');
        }}
        onOpenNewModal={() => setShowNewModal(true)}
        onOpenSearchModal={() => setShowSearchModal(true)}
        onOpenSubscriptionsModal={() => setShowSubscriptionsModal(true)}
        onOpenNetworkModal={() => setShowNetworkModal(true)}
        hasActiveSession={Boolean(activeSession)}
        activeSessionTitle={activeSession?.title}
        onReturnToActiveSession={() => setMobileView('session')}
      />

      {activeSession ? (
        <ErrorBoundary resetKey={activeSession.id}>
        <SessionDetail
          session={activeSession}
          agents={agents}
          onRefresh={() => {
            fetchSessions();
            if (selectedId) fetchSessionDetail(selectedId);
          }}
          onOpenSwitchModal={() => setShowSwitchModal(true)}
          onOpenSubscriptionsModal={() => setShowSubscriptionsModal(true)}
          onBackToList={() => setMobileView('list')}
          onDeleted={handleDeleted}
          totalSessionsCount={sessions.length}
        />
        </ErrorBoundary>
      ) : loading ? (
        <div className="app-loading">Loading sessions…</div>
      ) : (
        <div className="empty-state-view" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', flexDirection: 'column', gap: '12px' }}>
          <div style={{ fontSize: '40px' }}>⚡</div>
          <div style={{ fontSize: '16px', fontWeight: 600 }}>
            {sessions.length === 0 ? 'No sessions yet' : 'No Session Selected'}
          </div>
          <button className="btn-new" onClick={() => setShowNewModal(true)}>
            + Start a Session
          </button>
          <div className="empty-state-hints">
            <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>N</kbd> new session · <kbd>j</kbd>/<kbd>k</kbd> move between sessions ·{' '}
            <kbd>/</kbd> search
            <br />
            <kbd>p</kbd> cycle priority · <kbd>c</kbd> mark for cleanup · <kbd>Esc</kbd> close dialogs
          </div>
        </div>
      )}

      {offline && (
        <div className="connection-banner" role="status">
          Lost connection to the ACP Terminal server. Reconnecting…
        </div>
      )}

      {showNewModal && (
        <NewSessionModal
          agents={agents}
          onClose={() => setShowNewModal(false)}
          onCreated={(newId) => {
            setShowNewModal(false);
            fetchSessions().then(() => {
              setSelectedId(newId);
              setMobileView('session');
            });
          }}
        />
      )}

      {showSwitchModal && activeSession && (
        <SwitchAgentModal
          currentSession={activeSession}
          agents={agents}
          onClose={() => setShowSwitchModal(false)}
          onSwitched={(newId) => {
            setShowSwitchModal(false);
            fetchSessions().then(() => {
              setSelectedId(newId);
              setMobileView('session');
            });
          }}
        />
      )}

      {showSearchModal && (
        <SearchModal
          onClose={() => setShowSearchModal(false)}
          onSelectSession={(id) => {
            setSelectedId(id);
            setMobileView('session');
          }}
        />
      )}

      {showSubscriptionsModal && (
        <SubscriptionsUsageModal
          onClose={() => setShowSubscriptionsModal(false)}
          onSelectSession={(id) => {
            setSelectedId(id);
            setMobileView('session');
            setShowSubscriptionsModal(false);
          }}
        />
      )}

      {showNetworkModal && (
        <NetworkModal onClose={() => setShowNetworkModal(false)} />
      )}
    </div>
  );
};
