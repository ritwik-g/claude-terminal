import React, { useEffect, useRef, useState } from 'react';
import type { AcpSession, ToolCallRecord } from '../types';
import { TerminalDrawer } from './TerminalDrawer';
import { CopyButton, OutputText } from './AgentTurn';
import { Badge, Button, EmptyState, Icon, Segmented, Spinner } from '../ui';
import { commandOf, durationLabel, isActive, isFailed, isShellCall, liveCallIds } from '../toolDisplay';

// Agents such as Claude Code and Codex run shell commands inside their own
// process, so nothing ever appears in a client-side PTY. This panel shows
// those commands (command, output, exit code) as a terminal-style feed, and
// keeps the interactive shell one click away.

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

type View = 'commands' | 'shell';
type FeedItem = { call: ToolCallRecord; viaSubagent: boolean; interrupted: boolean };

const cleanOutput = (s?: string) => s?.replace(ANSI, '').replace(/\r\n/g, '\n').trimEnd();

export const LiveTerminalPanel: React.FC<{ session: AcpSession }> = ({ session }) => {
  const [view, setView] = useState<View>('commands');
  // Keep the shell attached once opened, so switching views doesn't reconnect.
  const [shellOpened, setShellOpened] = useState(false);
  useEffect(() => {
    if (view === 'shell') setShellOpened(true);
  }, [view]);

  const live = liveCallIds(session);
  const commands: FeedItem[] = session.turns
    .flatMap((t) => t.toolCalls || [])
    .filter((c) => isShellCall(c) && Boolean(commandOf(c)))
    .map((c) => ({ call: c, viaSubagent: Boolean(c.parentToolUseId), interrupted: isActive(c) && !live.has(c.id) }));
  const running = commands.filter(({ call, interrupted }) => isActive(call) && !interrupted).length;
  const failed = commands.filter(({ call }) => isFailed(call)).length;

  const transcript = commands
    .map(({ call }) => {
      const out = cleanOutput(call.output);
      return `$ ${commandOf(call)}${out ? `\n${out}` : ''}${call.exitCode != null ? `\n[exit ${call.exitCode}]` : ''}`;
    })
    .join('\n\n');

  return (
    <div className="live-terminal-panel">
      <div className="live-terminal-toolbar">
        <Segmented<View>
          label="Terminal view"
          size="sm"
          value={view}
          onChange={setView}
          options={[
            {
              value: 'commands',
              icon: 'bot',
              label: (
                <>
                  Agent commands
                  {running > 0 ? <Spinner size={9} /> : commands.length > 0 && <span className="lt-seg-count">{commands.length}</span>}
                </>
              ),
            },
            { value: 'shell', icon: 'terminal', label: 'Your shell' },
          ]}
        />
        {view === 'commands' && commands.length > 0 && (
          <span className="lt-summary">
            {commands.length} command{commands.length === 1 ? '' : 's'}
            {running > 0 && <span className="lt-summary-running"> · {running} running</span>}
            {failed > 0 && <span className="lt-summary-failed"> · {failed} failed</span>}
          </span>
        )}
        <span className="lt-cwd" title={session.cwd}>
          <Icon name="folder" size={12} />
          <span className="lt-cwd-path">
            <bdi>{session.cwd}</bdi>
          </span>
        </span>
        {view === 'commands' && commands.length > 0 && <CopyButton text={transcript} label="Copy all" withText />}
      </div>
      {view === 'commands' && (
        <CommandFeed commands={commands} cwd={session.cwd} onOpenShell={() => setView('shell')} />
      )}
      {shellOpened && (
        <div className="live-terminal-shell" hidden={view !== 'shell'}>
          <TerminalDrawer sessionId={session.id} />
        </div>
      )}
    </div>
  );
};

const CommandFeed: React.FC<{
  commands: FeedItem[];
  cwd: string;
  onOpenShell: () => void;
}> = ({ commands, cwd, onOpenShell }) => {
  const endRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const signature = commands.map(({ call }) => `${call.id}:${call.status}:${call.output?.length || 0}`).join('|');

  useEffect(() => {
    if (stick.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [signature]);

  if (commands.length === 0) {
    return (
      <div className="command-feed is-empty">
        <EmptyState
          icon="terminal"
          title="No commands yet"
          description="Shell commands the agent runs will stream here with their output and exit codes."
          action={
            <Button icon="terminal" onClick={onOpenShell}>
              Open your shell in {cwd.split('/').filter(Boolean).pop() || cwd}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div
      className="command-feed"
      role="log"
      aria-label="Agent commands"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {commands.map(({ call, viaSubagent, interrupted }) => {
        const failed = isFailed(call);
        const active = isActive(call) && !interrupted;
        const output = cleanOutput(call.output);
        const duration = durationLabel(call);
        return (
          <div key={call.id} className={`feed-entry${failed ? ' is-failed' : ''}${active ? ' is-running' : ''}`}>
            <div className="feed-prompt">
              <span className="feed-caret" aria-hidden>
                $
              </span>
              <span className="feed-command">{commandOf(call)}</span>
              <span className="feed-meta">
                {viaSubagent && (
                  <Badge tone="neutral" icon="bot" title="Run by a subagent">
                    Subagent
                  </Badge>
                )}
                {call.background && <Badge tone="info">Background</Badge>}
                {interrupted && <Badge tone="neutral">Interrupted</Badge>}
                {active ? (
                  <Badge tone="accent">
                    <Spinner size={9} />
                    Running
                  </Badge>
                ) : call.exitCode != null ? (
                  <Badge tone={failed ? 'danger' : 'ok'} mono>
                    exit {call.exitCode}
                  </Badge>
                ) : failed ? (
                  <Badge tone="danger">Failed</Badge>
                ) : null}
                {duration && <span className="feed-duration">{duration}</span>}
              </span>
            </div>
            {call.description && <div className="feed-desc"># {call.description}</div>}
            {output ? (
              <pre className="feed-output">
                <OutputText text={output} />
              </pre>
            ) : !active && !interrupted && !call.background ? (
              <div className="feed-desc feed-empty-output">No output</div>
            ) : null}
            {call.error && <pre className="feed-output feed-error">{String(call.error)}</pre>}
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
};
