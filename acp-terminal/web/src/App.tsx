import React, { useState, useEffect, useCallback, useMemo } from 'react';
import type { AcpSession, AgentDescriptor, AgentTask, AgentTaskTextDelta, McpServer, SessionSummary } from './types';
import { api, connectWebSocket, saveToken } from './api';
import { Sidebar } from './components/Sidebar';
import { SessionDetail, nextPriority } from './components/SessionDetail';
import { NewSessionModal } from './components/NewSessionModal';
import { SwitchAgentModal } from './components/SwitchAgentModal';
import { CommandPalette, type PaletteAction } from './components/CommandPalette';
import { HomeDashboard } from './components/HomeDashboard';
import { BrandMark } from './components/BrandMark';
import { SubscriptionsUsageModal } from './components/SubscriptionsUsageModal';
import { NetworkModal } from './components/NetworkModal';
import { McpModal } from './components/mcp/McpModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import { MOD_KEY, needsAttention } from './components/Sidebar';
import { useTheme } from './design/theme';
import { Button, Field, Icon, Input, Spinner } from './ui';

/** Session ids in the order the sidebar shows them, honouring its filters and grouping. */
function visibleSessionOrder(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.sidebar [data-session-id]')).map(
    (el) => el.dataset.sessionId!
  );
}

/** Append one streamed chunk of a subagent's text or reasoning to its task (and, for a reply, its spawning call). */
function applyTaskText(prev: AcpSession, d: AgentTaskTextDelta): AcpSession {
  let next = prev;
  const tasks = prev.agentTasks || [];
  const ti = tasks.findIndex((t) => t.id === d.taskId);
  if (ti !== -1) {
    const task = tasks[ti];
    const segments = [...(task.segments || [])];
    const si = segments.findIndex((seg) => seg.id === d.segmentId);
    const seg = segments[si];
    if (seg && seg.kind !== 'tool') segments[si] = { ...seg, text: seg.text + d.text };
    else if (d.kind === 'text') segments.push({ kind: 'text', id: d.segmentId, text: d.text, messageId: d.messageId });
    else segments.push({ kind: 'thought', id: d.segmentId, text: d.text });
    const nextTasks = [...tasks];
    nextTasks[ti] = { ...task, segments };
    next = { ...next, agentTasks: nextTasks };
  }
  if (d.toolCallId) {
    const turnIdx = prev.turns.findIndex((t) => t.toolCalls?.some((c) => c.id === d.toolCallId));
    if (turnIdx !== -1) {
      const turns = [...prev.turns];
      const turn = turns[turnIdx];
      turns[turnIdx] = {
        ...turn,
        toolCalls: turn.toolCalls!.map((c) => (c.id === d.toolCallId ? { ...c, subagentText: (c.subagentText || '') + d.text } : c)),
      };
      next = { ...next, turns };
    }
  }
  return next;
}

export const App: React.FC = () => {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [agents, setAgents] = useState<AgentDescriptor[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<AcpSession | null>(null);
  const [showNewModal, setShowNewModal] = useState(false);
  const [showSwitchModal, setShowSwitchModal] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  // Agent to preselect in the new-session dialog (from a home quick-start card).
  const [newSessionAgentId, setNewSessionAgentId] = useState<string | null>(null);
  const [showSubscriptionsModal, setShowSubscriptionsModal] = useState(false);
  const [showNetworkModal, setShowNetworkModal] = useState(false);
  const [showMcpModal, setShowMcpModal] = useState(false);
  // Saved MCP servers, for the sidebar's count of the ones switched on
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [authError, setAuthError] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  // Start on the list: with nothing selected yet, the session pane on mobile is a dead end.
  const [mobileView, setMobileView] = useState<'list' | 'session'>('list');
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const { resolved: resolvedTheme, preference: themePreference, setPreference: setThemePreference } = useTheme();

  const fetchSessions = useCallback(async () => {
    try {
      const res = await api.getSessions();
      setSessions(res.sessions);
      setAuthError(false);
      setOffline(false);
      if (selectedId && !res.sessions.some((s) => s.id === selectedId)) {
        // The open session was deleted (here or from another tab/device).
        setSelectedId(res.sessions[0]?.id ?? null);
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
    saveToken(tokenInput.trim());
    window.location.search = `?token=${encodeURIComponent(tokenInput.trim())}`;
  };

  // Initial load
  useEffect(() => {
    Promise.all([
      api.getAgents().then((res) => setAgents(res.agents)).catch((err) => {
        if (err.message?.includes('401') || err.message?.includes('Unauthorized')) setAuthError(true);
      }),
      fetchSessions(),
      // The count is a nicety; never hold up the first paint or fail the load over it
      api.getMcpServers().then((res) => setMcpServers(res.servers)).catch(() => {}),
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
        // An agent reported its models and effort levels; the server cached them on its descriptor
        if (msg.event === 'agentOptions') {
          api.getAgents().then((res) => setAgents(res.agents)).catch(() => {});
        }
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
          if (Array.isArray(msg.agentTasks) || Array.isArray(msg.removedAgentTaskIds)) {
            // Only the tasks that changed are sent; replace them by id, and drop any merged away
            setActiveSession((prev) => {
              if (!prev || prev.id !== msg.sessionId) return prev;
              const removed = new Set<string>(msg.removedAgentTaskIds || []);
              const tasks = (prev.agentTasks || []).filter((x) => !removed.has(x.id));
              for (const t of (msg.agentTasks || []) as AgentTask[]) {
                const idx = tasks.findIndex((x) => x.id === t.id);
                if (idx === -1) tasks.push(t);
                else tasks[idx] = t;
              }
              return { ...prev, agentTasks: tasks };
            });
          }
          if (msg.taskText) {
            setActiveSession((prev) => (prev && prev.id === msg.sessionId ? applyTaskText(prev, msg.taskText as AgentTaskTextDelta) : prev));
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
          if (['turnCompleted', 'sessionStopped', 'sessionStarted', 'sessionSwitched', 'sessionCompacted', 'sessionRollback', 'backgroundSettled'].includes(msg.event || msg.type)) {
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
    showNewModal || showSwitchModal || showPalette || showSubscriptionsModal || showNetworkModal || showMcpModal;

  const openNewSession = useCallback((agentId?: string) => {
    setNewSessionAgentId(agentId ?? null);
    setShowNewModal(true);
  }, []);

  const goHome = useCallback(() => {
    setSelectedId(null);
    setMobileView('list');
  }, []);

  /** Update the open session's pin, priority or cleanup mark, then refresh. */
  const annotate = useCallback(
    (updates: Parameters<typeof api.updateAnnotations>[1], what: string) => {
      if (!selectedId) return;
      api
        .updateAnnotations(selectedId, updates)
        .then(() => {
          fetchSessions();
          fetchSessionDetail(selectedId);
        })
        .catch((err) => alert(`Could not update ${what}: ${err.message}`));
    },
    [selectedId, fetchSessions, fetchSessionDetail]
  );

  // Show how many sessions need the user in the tab title.
  useEffect(() => {
    const n = sessions.filter(needsAttention).length;
    document.title = n > 0 ? `(${n}) CodePit` : 'CodePit';
  }, [sessions]);

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
        setShowPalette(false);
        setShowSubscriptionsModal(false);
        setShowNetworkModal(false);
        setShowMcpModal(false);
        return;
      }

      if (e.key.toLowerCase() === 'n' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        openNewSession();
        return;
      }

      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        // Toggles the palette from anywhere, but doesn't stack it over another dialog.
        e.preventDefault();
        if (showPalette) setShowPalette(false);
        else if (!anyModalOpen) setShowPalette(true);
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
        setShowPalette(true);
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
        annotate({ priority: nextPriority(activeSession.user.priority) }, 'priority');
      } else if (e.key === 'c' && selectedId && activeSession) {
        annotate({ cleanup: !activeSession.user.cleanup }, 'cleanup mark');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedId, activeSession, anyModalOpen, showPalette, openNewSession, annotate]);

  const paletteActions = useMemo<PaletteAction[]>(() => {
    const list: PaletteAction[] = [];
    const current = activeSession && activeSession.id === selectedId ? activeSession : null;
    if (current) {
      const next = nextPriority(current.user.priority);
      list.push(
        {
          id: 'switch-agent',
          label: 'Switch agent',
          icon: 'swap',
          group: 'Current session',
          keywords: 'change vendor model handoff',
          run: () => setShowSwitchModal(true),
        },
        {
          id: 'pin',
          label: current.user.pinned ? 'Unpin session' : 'Pin session',
          icon: 'pin',
          group: 'Current session',
          keywords: 'pin unpin favourite',
          run: () => annotate({ pinned: !current.user.pinned }, 'pin'),
        },
        {
          id: 'priority',
          label: next ? `Set priority to ${next.toUpperCase()}` : 'Clear priority',
          icon: 'star',
          group: 'Current session',
          keywords: 'priority p0 p1 p2 importance',
          shortcut: ['p'],
          run: () => annotate({ priority: next }, 'priority'),
        },
        {
          id: 'cleanup',
          label: current.user.cleanup ? 'Unmark for cleanup' : 'Mark for cleanup',
          icon: 'archive',
          group: 'Current session',
          keywords: 'cleanup archive done tidy',
          shortcut: ['c'],
          run: () => annotate({ cleanup: !current.user.cleanup }, 'cleanup mark'),
        }
      );
    }
    list.push({
      id: 'new',
      label: 'New session',
      icon: 'plus',
      group: 'Actions',
      keywords: 'start create launch agent',
      shortcut: [MOD_KEY, 'N'],
      run: () => openNewSession(),
    });
    if (selectedId) {
      list.push({ id: 'home', label: 'Go to home', icon: 'home', group: 'Actions', keywords: 'dashboard overview', run: goHome });
    }
    const other = resolvedTheme === 'dark' ? 'light' : 'dark';
    list.push({
      id: 'theme',
      label: `Switch to ${other} theme`,
      icon: other === 'light' ? 'sun' : 'moon',
      group: 'Actions',
      keywords: 'toggle theme appearance dark light mode',
      run: () => setThemePreference(other),
    });
    if (themePreference !== 'system') {
      list.push({
        id: 'theme-system',
        label: 'Use system theme',
        icon: 'monitor',
        group: 'Actions',
        keywords: 'theme appearance auto os',
        run: () => setThemePreference('system'),
      });
    }
    list.push(
      {
        id: 'lan',
        label: 'Open LAN access',
        icon: 'wifi',
        group: 'Actions',
        keywords: 'network phone device token share url',
        run: () => setShowNetworkModal(true),
      },
      {
        id: 'mcp',
        label: 'Open MCP servers and plugins',
        icon: 'plug',
        group: 'Actions',
        keywords: 'mcp tools servers plugins skills github filesystem memory search database',
        run: () => setShowMcpModal(true),
      },
      {
        id: 'subscriptions',
        label: 'Open subscriptions and usage',
        icon: 'card',
        group: 'Actions',
        keywords: 'settings billing credentials cost plan limits',
        run: () => setShowSubscriptionsModal(true),
      }
    );
    for (const a of agents) {
      list.push({
        id: `new-${a.id}`,
        label: `New ${a.name} session`,
        icon: 'plus',
        group: 'Actions',
        keywords: `start ${a.id} ${a.provider}`,
        searchOnly: true,
        run: () => openNewSession(a.id),
      });
    }
    return list;
  }, [activeSession, selectedId, agents, resolvedTheme, themePreference, annotate, openNewSession, goHome, setThemePreference]);

  if (authError && sessions.length === 0) {
    return (
      <div className="auth-screen">
        <form className="auth-card" onSubmit={handleManualTokenSubmit}>
          <span className="auth-icon" aria-hidden>
            <Icon name="lock" size={20} />
          </span>
          <h1 className="auth-title">Connect to CodePit</h1>
          <p className="auth-desc">
            You're opening the workspace from another device (<code>{window.location.host}</code>). Paste the access token
            from the host computer to continue.
          </p>
          <Field
            label="Access token"
            htmlFor="auth-token"
            hint="On the host, open LAN access in the sidebar to copy the token, or a link that signs you in."
          >
            <Input
              id="auth-token"
              type="text"
              mono
              placeholder="Paste the token"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </Field>
          <Button type="submit" variant="primary" size="lg" block disabled={!tokenInput.trim()}>
            Connect
          </Button>
        </form>
      </div>
    );
  }

  if (loading && sessions.length === 0) {
    return <AppSkeleton />;
  }

  const newSessionAgents =
    newSessionAgentId && agents.some((a) => a.id === newSessionAgentId)
      ? // NewSessionModal preselects the first agent, so put the chosen one first.
        [...agents.filter((a) => a.id === newSessionAgentId), ...agents.filter((a) => a.id !== newSessionAgentId)]
      : agents;

  return (
    <div className={`app-container mobile-view-${mobileView}`}>
      <Sidebar
        sessions={sessions}
        selectedId={selectedId}
        onSelectSession={(id) => {
          setSelectedId(id);
          setMobileView('session');
        }}
        onGoHome={goHome}
        onOpenNewModal={() => openNewSession()}
        onOpenPalette={() => setShowPalette(true)}
        onOpenSubscriptionsModal={() => setShowSubscriptionsModal(true)}
        onOpenNetworkModal={() => setShowNetworkModal(true)}
        onOpenMcpModal={() => setShowMcpModal(true)}
        mcpActiveCount={mcpServers.filter((s) => s.enabled).length}
        hasActiveSession={Boolean(activeSession)}
        activeSessionTitle={activeSession?.title}
        onReturnToActiveSession={() => setMobileView('session')}
      />

      {activeSession && selectedId ? (
        <ErrorBoundary resetKey={activeSession.id} onLeave={{ label: 'Go to home', run: goHome }}>
          <SessionDetail
            session={activeSession}
            agents={agents}
            onRefresh={() => {
              fetchSessions();
              if (selectedId) fetchSessionDetail(selectedId);
            }}
            onOpenSwitchModal={() => setShowSwitchModal(true)}
            onOpenSubscriptionsModal={() => setShowSubscriptionsModal(true)}
            onOpenMcp={() => setShowMcpModal(true)}
            onBackToList={() => setMobileView('list')}
            onDeleted={handleDeleted}
            totalSessionsCount={sessions.length}
          />
        </ErrorBoundary>
      ) : selectedId ? (
        <MainSkeleton />
      ) : (
        <ErrorBoundary resetKey="home">
          <HomeDashboard
            sessions={sessions}
            agents={agents}
            onSelectSession={(id) => {
              setSelectedId(id);
              setMobileView('session');
            }}
            onNewSession={openNewSession}
            onOpenPalette={() => setShowPalette(true)}
          />
        </ErrorBoundary>
      )}

      {offline && (
        <div className="conn-toast" role="status">
          <Spinner size={13} />
          <span className="conn-toast-text">
            <strong>Connection lost.</strong> Reconnecting to the server…
          </span>
        </div>
      )}

      {showNewModal && (
        <NewSessionModal
          agents={newSessionAgents}
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

      {showPalette && (
        <CommandPalette
          sessions={sessions}
          currentSessionId={selectedId}
          actions={paletteActions}
          onClose={() => setShowPalette(false)}
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

      {showNetworkModal && <NetworkModal onClose={() => setShowNetworkModal(false)} />}

      {showMcpModal && (
        <McpModal
          agents={agents}
          workspace={activeSession?.cwd}
          onClose={() => setShowMcpModal(false)}
          onServersChange={setMcpServers}
        />
      )}
    </div>
  );
};

/** Placeholder for the main pane while a session loads. */
const MainSkeleton: React.FC = () => (
  <div className="main-skeleton" aria-busy="true" aria-label="Loading session">
    <div className="skel-header">
      <span className="skel skel-dot" />
      <span className="skel skel-line w-30" />
      <span className="skel skel-line w-10 push" />
    </div>
    <div className="skel-body">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="skel-block">
          <span className="skel skel-line w-15" />
          <span className="skel skel-line w-70" />
          <span className="skel skel-line w-45" />
        </div>
      ))}
    </div>
  </div>
);

/** First paint while sessions load: the shell's shape, without content. */
const AppSkeleton: React.FC = () => (
  <div className="app-container mobile-view-list" aria-busy="true" aria-label="Loading CodePit">
    <aside className="sidebar sidebar-skeleton" aria-hidden>
      <div className="sb-head">
        <span className="sb-brand">
          <BrandMark />
          <span className="sb-brand-name">CodePit</span>
        </span>
      </div>
      <div className="skel-side">
        <span className="skel skel-row-lg" />
        <span className="skel skel-row-lg" />
        <span className="skel skel-line w-40" />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="skel-session">
            <span className="skel skel-line w-70" />
            <span className="skel skel-line w-45" />
          </div>
        ))}
      </div>
    </aside>
    <div className="main-skeleton main-home">
      <div className="skel-home">
        <span className="skel skel-title" />
        <span className="skel skel-line w-40" />
        <div className="skel-cards">
          <span className="skel skel-card" />
          <span className="skel skel-card" />
          <span className="skel skel-card" />
        </div>
      </div>
    </div>
  </div>
);
