import React, { useState, useEffect, useCallback } from 'react';
import type { AcpSession, AgentDescriptor, SessionSummary } from './types';
import { api, connectWebSocket } from './api';
import { Sidebar } from './components/Sidebar';
import { SessionDetail } from './components/SessionDetail';
import { NewSessionModal } from './components/NewSessionModal';
import { SwitchAgentModal } from './components/SwitchAgentModal';
import { SearchModal } from './components/SearchModal';
import { SubscriptionsUsageModal } from './components/SubscriptionsUsageModal';
import { NetworkModal } from './components/NetworkModal';

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
  const [mobileView, setMobileView] = useState<'list' | 'session'>('session');
  const [loading, setLoading] = useState(true);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await api.getSessions();
      setSessions(res.sessions);
      setAuthError(false);
      if (!selectedId && res.sessions.length > 0) {
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
    const ws = connectWebSocket((msg) => {
      if (msg.type === 'sessionsUpdated' && Array.isArray(msg.sessions)) {
        setSessions(msg.sessions);
        if (selectedId) {
          const match = msg.sessions.find((s) => s.id === selectedId);
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
    });

    return () => {
      ws.close();
    };
  }, [selectedId, fetchSessionDetail, fetchSessions]);

  // Keyboard navigation shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept if focus is inside input/textarea
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        return;
      }

      if (e.key === '/') {
        e.preventDefault();
        setShowSearchModal(true);
      } else if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        if (sessions.length === 0) return;
        const idx = sessions.findIndex((s) => s.id === selectedId);
        const next = idx === -1 || idx === sessions.length - 1 ? 0 : idx + 1;
        setSelectedId(sessions[next].id);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (sessions.length === 0) return;
        const idx = sessions.findIndex((s) => s.id === selectedId);
        const prev = idx <= 0 ? sessions.length - 1 : idx - 1;
        setSelectedId(sessions[prev].id);
      } else if (e.key.toLowerCase() === 'n' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setShowNewModal(true);
      } else if (e.key === 'c' && selectedId && activeSession) {
        api.updateAnnotations(selectedId, { cleanup: !activeSession.user.cleanup }).then(() => {
          fetchSessions();
          fetchSessionDetail(selectedId);
        });
      } else if (e.key === 'Escape') {
        setShowNewModal(false);
        setShowSwitchModal(false);
        setShowSearchModal(false);
        setShowSubscriptionsModal(false);
        setShowNetworkModal(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [sessions, selectedId, activeSession, fetchSessions, fetchSessionDetail]);

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
          totalSessionsCount={sessions.length}
        />
      ) : (
        <div className="empty-state-view" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', flexDirection: 'column', gap: '12px' }}>
          <div style={{ fontSize: '40px' }}>⚡</div>
          <div style={{ fontSize: '16px', fontWeight: 600 }}>No Session Selected</div>
          <button className="btn-new" onClick={() => setShowNewModal(true)}>
            + Start a Session
          </button>
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
