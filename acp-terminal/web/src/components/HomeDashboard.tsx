import React from 'react';
import type { AgentDescriptor, SessionSummary } from '../types';
import { Badge, Button, EmptyState, Icon, Kbd, StatusDot } from '../ui';
import { VendorIcon } from './VendorLogos';
import { MOD_KEY, PriorityBadge, SessionMeta, needsAttention, relativeTime, sessionPreview, sessionStatus } from './Sidebar';

interface HomeDashboardProps {
  sessions: SessionSummary[];
  agents: AgentDescriptor[];
  onSelectSession: (id: string) => void;
  /** Opens the new-session dialog, with `agentId` preselected when given. */
  onNewSession: (agentId?: string) => void;
  onOpenPalette: () => void;
}

const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: [MOD_KEY, 'K'], label: 'Search and run commands' },
  { keys: [MOD_KEY, 'N'], label: 'Start a new session' },
  { keys: ['j', 'k'], label: 'Next or previous session' },
  { keys: ['/'], label: 'Search sessions' },
  { keys: ['p'], label: 'Cycle priority' },
  { keys: ['c'], label: 'Mark for cleanup' },
  { keys: ['Enter'], label: 'Open the selected session' },
  { keys: ['Esc'], label: 'Close dialogs' },
];

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const HomeDashboard: React.FC<HomeDashboardProps> = ({ sessions, agents, onSelectSession, onNewSession, onOpenPalette }) => {
  const attention = sessions.filter(needsAttention);
  const working = sessions.filter((s) => s.state === 'working');
  const recent = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
  const firstRun = sessions.length === 0;

  const summary = firstRun
    ? 'Run Claude Code, Codex, Gemini and other ACP agents side by side, and step in only when one needs you.'
    : attention.length > 0
    ? `${plural(attention.length, 'session needs', 'sessions need')} you${working.length ? `, ${working.length} working` : ''}.`
    : working.length > 0
    ? `${plural(working.length, 'session is', 'sessions are')} working. Nothing needs you right now.`
    : 'All quiet. Nothing needs you right now.';

  return (
    <main className="home main-home" aria-label="Home">
      <div className="home-inner">
        {firstRun ? (
          <div className="home-welcome">
            <EmptyState
              icon="terminal"
              title="Welcome to ACP Terminal"
              description={summary}
              action={
                <Button variant="primary" size="lg" icon="plus" onClick={() => onNewSession()}>
                  Start your first session
                </Button>
              }
            />
          </div>
        ) : (
          <header className="home-head">
            <div className="home-head-text">
              <h1 className="home-title">{greeting()}</h1>
              <p className="home-sub">{summary}</p>
            </div>
            <div className="home-head-actions">
              <Button variant="secondary" icon="search" onClick={onOpenPalette}>
                Search
                <span className="home-btn-keys">
                  <Kbd>{MOD_KEY}</Kbd>
                  <Kbd>K</Kbd>
                </span>
              </Button>
              <Button variant="primary" icon="plus" onClick={() => onNewSession()}>
                New session
              </Button>
            </div>
          </header>
        )}

        {attention.length > 0 && (
          <section className="home-section" aria-labelledby="home-attention">
            <div className="home-section-head">
              <h2 id="home-attention" className="home-section-title">
                Needs your attention
              </h2>
              <span className="home-section-count">{attention.length}</span>
            </div>
            <div className="home-list">
              {attention.map((s) => {
                // Lead with why the session needs the user; a stopped agent is a
                // secondary note, not the reason it's listed here.
                const status = sessionStatus({ state: s.state, isAgentRunning: true });
                const stopped = sessionStatus(s).label === 'Agent stopped';
                const preview = sessionPreview(s);
                return (
                  <button key={s.id} type="button" className={`home-attn tone-${status.tone}`} onClick={() => onSelectSession(s.id)}>
                    <span className="home-attn-top">
                      <StatusDot tone={status.tone} pulse={status.pulse} />
                      <span className="home-attn-title">{s.title}</span>
                      <PriorityBadge priority={s.user.priority} />
                      {stopped && <Badge tone="neutral">Agent stopped</Badge>}
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </span>
                    {preview.text && (
                      <span className={`home-attn-preview ${preview.approval ? 'is-approval' : ''}`}>
                        {preview.approval && <Icon name="shield" size={13} />}
                        <span className="home-attn-preview-text">{preview.text}</span>
                      </span>
                    )}
                    <span className="home-attn-foot">
                      <SessionMeta session={s} />
                      <span className="home-time">{relativeTime(s.updatedAt)}</span>
                      <span className="home-attn-open">
                        {preview.approval ? 'Review' : 'Open'}
                        <Icon name="arrowRight" size={13} />
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {!firstRun && (
          <section className="home-section" aria-labelledby="home-recent">
            <div className="home-section-head">
              <h2 id="home-recent" className="home-section-title">
                Recent sessions
              </h2>
            </div>
            <div className="home-recent">
              {recent.map((s) => {
                const status = sessionStatus(s);
                return (
                  <button key={s.id} type="button" className="home-recent-row" onClick={() => onSelectSession(s.id)}>
                    <StatusDot tone={status.tone} pulse={status.pulse} label={status.label} />
                    <span className="home-recent-title">{s.title}</span>
                    <span className="home-recent-meta">
                      <SessionMeta session={s} showModel={false} />
                    </span>
                    <span className="home-recent-state">{status.label}</span>
                    <span className="home-time">{relativeTime(s.updatedAt)}</span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {agents.length > 0 && (
          <section className="home-section" aria-labelledby="home-start">
            <div className="home-section-head">
              <h2 id="home-start" className="home-section-title">
                {firstRun ? 'Pick an agent to start with' : 'Start a session'}
              </h2>
            </div>
            <div className="home-agents">
              {agents.map((a) => (
                <button key={a.id} type="button" className="home-agent" onClick={() => onNewSession(a.id)}>
                  <span className="home-agent-head">
                    <span className="home-agent-mark">
                      <VendorIcon agentId={a.id} size={18} />
                    </span>
                    <span className="home-agent-name">{a.name}</span>
                    <Icon name="plus" size={14} className="home-agent-plus" />
                  </span>
                  {a.description && <span className="home-agent-desc">{a.description}</span>}
                  {a.defaultModel && <span className="home-agent-model mono">{a.defaultModel}</span>}
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="home-section" aria-labelledby="home-keys">
          <div className="home-section-head">
            <h2 id="home-keys" className="home-section-title">
              Keyboard shortcuts
            </h2>
          </div>
          <div className="home-keys">
            {SHORTCUTS.map((k) => (
              <div key={k.label} className="home-key">
                <span className="home-key-label">{k.label}</span>
                <span className="home-key-keys">
                  {k.keys.map((key) => (
                    <Kbd key={key}>{key}</Kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
};
