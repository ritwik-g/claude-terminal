import React, { useEffect, useRef, useState } from 'react';
import type { AcpSession, ToolCallRecord } from '../types';
import { TerminalDrawer } from './TerminalDrawer';
import { Icon, Spinner } from './Icons';
import { commandOf, durationLabel, isActive, isShellCall } from '../toolDisplay';

// Agents such as Claude Code and Codex run shell commands inside their own
// process, so nothing ever appears in a client-side PTY. This panel shows
// those commands (command, output, exit code) as a terminal-style feed, and
// keeps the interactive shell one click away.

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export const LiveTerminalPanel: React.FC<{ session: AcpSession }> = ({ session }) => {
  const [view, setView] = useState<'commands' | 'shell'>('commands');

  const commands: Array<{ call: ToolCallRecord; viaSubagent: boolean }> = session.turns
    .flatMap((t) => t.toolCalls || [])
    .filter((c) => isShellCall(c) && Boolean(commandOf(c)))
    .map((c) => ({ call: c, viaSubagent: Boolean(c.parentToolUseId) }));
  const running = commands.filter(({ call }) => isActive(call)).length;

  return (
    <div className="live-terminal-panel">
      <div className="live-terminal-toolbar" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'commands'}
          className={`segmented-btn ${view === 'commands' ? 'active' : ''}`}
          onClick={() => setView('commands')}
        >
          <Icon name="bot" size={13} /> Agent commands
          {commands.length > 0 && <span className="segmented-count">{commands.length}</span>}
          {running > 0 && <Spinner size={10} />}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'shell'}
          className={`segmented-btn ${view === 'shell' ? 'active' : ''}`}
          onClick={() => setView('shell')}
        >
          <Icon name="terminal" size={13} /> Your shell
        </button>
        <span className="live-terminal-cwd" title={session.cwd}>
          <Icon name="folder" size={12} /> {session.cwd}
        </span>
      </div>
      {view === 'commands' ? (
        <CommandFeed commands={commands} cwd={session.cwd} onOpenShell={() => setView('shell')} />
      ) : (
        <div className="live-terminal-shell">
          <TerminalDrawer sessionId={session.id} />
        </div>
      )}
    </div>
  );
};

const CommandFeed: React.FC<{
  commands: Array<{ call: ToolCallRecord; viaSubagent: boolean }>;
  cwd: string;
  onOpenShell: () => void;
}> = ({ commands, cwd, onOpenShell }) => {
  const endRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const signature = commands.map(({ call }) => `${call.id}:${call.status}:${call.output?.length || 0}`).join('|');

  useEffect(() => {
    if (stick.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [signature]);

  if (commands.length === 0) {
    return (
      <div className="command-feed-empty">
        <Icon name="terminal" size={28} />
        <div className="command-feed-empty-title">No commands yet</div>
        <div>Shell commands the agent runs will stream here with their output and exit codes.</div>
        <button type="button" className="btn-secondary" onClick={onOpenShell}>
          Open your shell in {cwd.split('/').filter(Boolean).pop() || cwd}
        </button>
      </div>
    );
  }

  return (
    <div
      className="command-feed"
      ref={feedRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {commands.map(({ call, viaSubagent }) => {
        const failed = call.status === 'failed' || (call.exitCode != null && call.exitCode !== 0);
        const output = call.output?.replace(ANSI, '').replace(/\r\n/g, '\n').trimEnd();
        const duration = durationLabel(call);
        return (
          <div key={call.id} className={`feed-entry ${failed ? 'failed' : ''}`}>
            <div className="feed-prompt">
              <span className="feed-caret">$</span>
              <span className="feed-command">{commandOf(call)}</span>
              <span className="feed-meta">
                {viaSubagent && (
                  <span className="pill" title="Run by a subagent">
                    <Icon name="bot" size={11} /> subagent
                  </span>
                )}
                {call.background && <span className="pill">background</span>}
                {isActive(call) ? (
                  <Spinner size={10} />
                ) : call.exitCode != null ? (
                  <span className={`pill ${failed ? 'pill-fail' : 'pill-ok'}`}>exit {call.exitCode}</span>
                ) : failed ? (
                  <span className="pill pill-fail">failed</span>
                ) : null}
                {duration && <span>{duration}</span>}
              </span>
            </div>
            {call.description && <div className="feed-desc"># {call.description}</div>}
            {output ? (
              <pre className="feed-output">{output}</pre>
            ) : !isActive(call) && !call.background ? (
              <div className="feed-desc">(no output)</div>
            ) : null}
            {call.error && <pre className="feed-output tool-err">{String(call.error)}</pre>}
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
};
