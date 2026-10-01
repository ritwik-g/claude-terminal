import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AcpSession, FileAttachment, TurnMessage } from '../types';
import { withToken } from '../api';
import { Badge, Button, EmptyState, Icon, IconButton, Spinner } from '../ui';
import { AgentTurnBody } from './AgentTurn';
import { CompactionCard } from './CompactionCard';
import { VendorIcon } from './VendorLogos';
import { getModelMeta } from './AgentModelPicker';
import { cx, formatBytes, formatTime } from './sessionMeta';

const TURN_WINDOW = 120;
// Within this distance of the bottom the view keeps following new output.
const STICK_THRESHOLD = 120;

export type RollbackAction = 'revert_to_this' | 'revert_before_this' | 'undo_last';

interface Suggestion {
  label: string;
  prompt: string;
  tooltip: string;
}

function useSuggestions(session: AcpSession, lastAgentText: string, hasActiveToolCalls: boolean): Suggestion[] {
  return useMemo(() => {
    if (session.state === 'working' && hasActiveToolCalls) return [];
    const chips: Suggestion[] = [];

    // The agent's own suggested prompt (e.g. Claude Code) comes first.
    if (session.promptSuggestion) {
      const s = session.promptSuggestion;
      chips.push({
        label: s.length > 36 ? s.slice(0, 36) + '…' : s,
        prompt: s,
        tooltip: `Suggested by the agent: "${s}" (click to insert, or press Tab in the composer)`,
      });
    }

    if (!lastAgentText) return chips;
    const textLower = lastAgentText.toLowerCase();

    // Word boundaries matter: a bare includes('pr') matched "approval", "prompt", "improve"...
    if (session.git?.branch && /\b(pr|pull request)\b/.test(textLower)) {
      chips.push({ label: 'Proceed with the PR', prompt: 'Please proceed with creating the pull request.', tooltip: 'Ask the agent to open the PR' });
      chips.push({ label: 'Show the diff', prompt: 'Can you show me the git diff?', tooltip: 'Inspect the git changes before going on' });
    }
    if (/\b(tests?|validate|verify)\b/.test(textLower)) {
      chips.push({
        label: 'Run the tests',
        prompt: 'Please run the test suite and verify everything passes.',
        tooltip: 'Run the test suite to validate the changes',
      });
    }
    if (chips.length === 0) {
      chips.push({ label: 'Continue', prompt: 'Looks good, please proceed with the next steps.', tooltip: 'Ask the agent to continue' });
      chips.push({
        label: 'What is the status?',
        prompt: 'What is the current status and what needs to be done next?',
        tooltip: 'Ask for a status update',
      });
    }
    chips.push({ label: 'Undo last turn', prompt: '/undo', tooltip: 'Undo the last turn' });
    return chips;
  }, [lastAgentText, session.state, session.promptSuggestion, session.git?.branch, hasActiveToolCalls]);
}

const TurnAttachments: React.FC<{ attachments: FileAttachment[]; onPreviewImage: (src: string) => void }> = ({
  attachments,
  onPreviewImage,
}) => (
  <div className="ws-user-attachments">
    {attachments.map((att) => {
      const src = att.url ? withToken(att.url) : att.data;
      return att.isImage ? (
        <button
          key={att.id}
          type="button"
          className="ws-user-image"
          onClick={() => src && onPreviewImage(src)}
          title={`View ${att.name}`}
        >
          <img src={src} alt={att.name} />
        </button>
      ) : (
        <a key={att.id} href={att.url ? withToken(att.url) : '#'} download={att.name} className="ws-user-file" title={`Download ${att.name}`}>
          <span className="ws-file-icon">
            <Icon name="file" size={15} />
          </span>
          <span className="ws-file-text">
            <span className="ws-file-name">{att.name}</span>
            <span className="ws-file-size">{formatBytes(att.size)}</span>
          </span>
          <Icon name="download" size={14} className="ws-file-dl" />
        </a>
      );
    })}
  </div>
);

const UserTurn: React.FC<{
  turn: TurnMessage;
  onRollback: (turnId: string, action: RollbackAction) => void;
  onPreviewImage: (src: string) => void;
}> = ({ turn, onRollback, onPreviewImage }) => (
  <div className="ws-turn ws-turn-user">
    <div className="ws-user-meta">
      <span className="ws-turn-actions">
        <IconButton
          icon="edit"
          size="sm"
          label="Edit and resend"
          title="Edit: remove this message and everything after it, and put it back in the composer"
          onClick={() => onRollback(turn.id, 'revert_before_this')}
        />
        <IconButton
          icon="undo"
          size="sm"
          label="Rewind to here"
          title="Rewind the conversation so this is the last message"
          onClick={() => onRollback(turn.id, 'revert_to_this')}
        />
      </span>
      {turn.keywords?.map((k) => (
        <Badge key={k} tone="accent" icon={k === 'ultracode' ? 'layers' : 'brain'} title={`Sent to Claude with "${k}"`}>
          {k === 'ultracode' ? 'Ultracode' : 'Ultrathink'}
        </Badge>
      ))}
      <time className="ws-time" dateTime={new Date(turn.timestamp).toISOString()}>
        {formatTime(turn.timestamp)}
      </time>
    </div>
    {turn.attachments && turn.attachments.length > 0 && (
      <TurnAttachments attachments={turn.attachments} onPreviewImage={onPreviewImage} />
    )}
    {turn.content && <div className="ws-user-bubble">{turn.content}</div>}
  </div>
);

const AgentTurn: React.FC<{
  session: AcpSession;
  turn: TurnMessage;
  prev?: TurnMessage;
  isLast: boolean;
  onRollback: (turnId: string, action: RollbackAction) => void;
}> = ({ session, turn, prev, isLast, onRollback }) => {
  const turnAgentId = turn.agentId || session.agentId;
  const turnAgentName = (turn.agentName || session.agentName).replace(/ \(ACP\)$/, '');
  const turnModel = turn.model || session.model;
  const turnModelMeta = turnModel ? getModelMeta(turnModel) : null;
  // Back-to-back agent turns (e.g. a follow-up after an approval or a
  // background task finishing) read as one reply: skip the repeated header.
  const continuesReply = prev?.role === 'agent' && (prev.agentId || session.agentId) === turnAgentId;

  return (
    <div className={cx('ws-turn ws-turn-agent', continuesReply && 'is-continuation')}>
      <div className="ws-agent-head">
        {!continuesReply && (
          <>
            <span className="ws-agent-avatar">
              <VendorIcon agentId={turnAgentId} size={14} />
            </span>
            <span className="ws-agent-name">{turnAgentName}</span>
            {turnModel && (
              <Badge mono title={turnModelMeta ? `${turnModelMeta.label} (${turnModelMeta.provider})` : turnModel}>
                {turnModelMeta?.label || turnModel}
              </Badge>
            )}
            <time className="ws-time" dateTime={new Date(turn.timestamp).toISOString()}>
              {formatTime(turn.timestamp)}
            </time>
          </>
        )}
        <span className="ws-turn-actions">
          <IconButton
            icon="undo"
            size="sm"
            label="Rewind to here"
            title="Rewind the conversation so this response is the last turn"
            onClick={() => onRollback(turn.id, 'revert_to_this')}
          />
          <IconButton
            icon="trash"
            size="sm"
            tone="danger"
            label="Delete from here"
            title="Delete this response and everything after it"
            onClick={() => onRollback(turn.id, 'revert_before_this')}
          />
        </span>
      </div>
      <AgentTurnBody
        turn={turn}
        isActiveTurn={isLast && (session.state === 'working' || Boolean(session.pendingPermission || session.pendingElicitation))}
        isAwaitingApproval={isLast && Boolean(session.pendingPermission)}
        awaitingAnswerId={session.pendingElicitation?.toolCallId}
      />
    </div>
  );
};

export const ConversationView: React.FC<{
  session: AcpSession;
  onRollback: (turnId: string | undefined, action: RollbackAction) => void;
  onPreviewImage: (src: string) => void;
  onCancelPrompt: () => void;
  onInsertPrompt: (text: string) => void;
}> = ({ session, onRollback, onPreviewImage, onCancelPrompt, onInsertPrompt }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Follow new output only while the reader is at the bottom; scrolling up to
  // read earlier turns must not be yanked back on every streamed chunk.
  const stickToBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  // Very long sessions render only the newest turns until asked for more.
  const [showAllTurns, setShowAllTurns] = useState(false);
  useEffect(() => {
    setShowAllTurns(false);
    stickToBottomRef.current = true;
    setShowJump(false);
  }, [session.id]);
  const hiddenTurnCount = showAllTurns ? 0 : Math.max(0, session.turns.length - TURN_WINDOW);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    // Instant, not smooth: a smooth scroll emits intermediate scroll events that
    // would read as "user scrolled up" and unstick the view.
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [session.turns, session.id, session.state, session.pendingPermission, session.pendingElicitation]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance < STICK_THRESHOLD;
    const jump = distance > STICK_THRESHOLD * 3;
    setShowJump((prev) => (prev === jump ? prev : jump));
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const lastTurn = session.turns.length > 0 ? session.turns[session.turns.length - 1] : null;
  const lastAgentText = (lastTurn && lastTurn.role === 'agent' ? lastTurn.content : '') || '';
  const hasActiveToolCalls = Boolean(
    lastTurn?.role === 'agent' && lastTurn?.toolCalls?.some((tc) => tc.status === 'pending' || tc.status === 'running')
  );
  const suggestions = useSuggestions(session, lastAgentText, hasActiveToolCalls);
  const working = session.state === 'working' && !session.pendingPermission && !session.pendingElicitation;
  const wrappingUp = Boolean(lastAgentText) && !hasActiveToolCalls;

  return (
    <div className="ws-conversation">
      <div className="ws-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="ws-column">
          {session.turns.length === 0 && (
            <div className="ws-empty">
              <EmptyState
                icon="message"
                title={`Session started with ${session.agentName.replace(/ \(ACP\)$/, '')}`}
                description="Describe a goal or give an instruction below to begin."
              />
            </div>
          )}

          {hiddenTurnCount > 0 && (
            <div className="ws-show-earlier">
              <Button variant="secondary" size="sm" icon="chevronUp" onClick={() => setShowAllTurns(true)}>
                Show {hiddenTurnCount} earlier message{hiddenTurnCount === 1 ? '' : 's'}
              </Button>
            </div>
          )}

          {session.turns.map((turn, index) => {
            if (index < hiddenTurnCount) return null;
            if (turn.role === 'system' && turn.compaction) {
              return <CompactionCard key={turn.id} turn={turn} />;
            }
            if (turn.role === 'system') {
              return (
                <div key={turn.id} className="ws-system-event" role="note">
                  <span className="ws-system-pill">
                    <Icon name="info" size={12} />
                    <span className="ws-system-text">{turn.content}</span>
                    <IconButton
                      icon="x"
                      size="sm"
                      className="ws-system-remove"
                      label="Remove this event"
                      title="Remove this event and undo the messages after it"
                      onClick={() => onRollback(turn.id, 'revert_before_this')}
                    />
                  </span>
                </div>
              );
            }
            if (turn.role === 'user') {
              return <UserTurn key={turn.id} turn={turn} onRollback={onRollback} onPreviewImage={onPreviewImage} />;
            }
            return (
              <AgentTurn
                key={turn.id}
                session={session}
                turn={turn}
                prev={session.turns[index - 1]}
                isLast={index === session.turns.length - 1}
                onRollback={onRollback}
              />
            );
          })}

          {session.turns.length > 0 && (
            <div className="ws-status-area">
              {working ? (
                <div className="ws-status is-working" role="status">
                  <Spinner size={12} />
                  <span>{wrappingUp ? 'Wrapping up…' : 'Working…'}</span>
                  <span className="ws-status-actions">
                    {wrappingUp && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={onCancelPrompt}
                        title="The reply has arrived; end the turn now instead of waiting for the agent to close it"
                      >
                        End turn
                      </Button>
                    )}
                  </span>
                </div>
              ) : session.pendingPermission ? (
                <div className="ws-status is-blocked" role="status">
                  <Icon name="shield" size={13} />
                  <span className="ws-status-text" title={session.pendingPermission.title}>
                    Waiting for your approval below
                  </span>
                </div>
              ) : session.pendingElicitation ? (
                <div className="ws-status is-blocked" role="status">
                  <Icon name="help" size={13} />
                  <span className="ws-status-text" title={session.pendingElicitation.message}>
                    Waiting for your answer below
                  </span>
                </div>
              ) : (
                suggestions.length > 0 && (
                  <div className="ws-suggestions" aria-label="Suggested replies">
                    {suggestions.map((s, i) => (
                      <button
                        key={i}
                        type="button"
                        className={cx('ws-chip', i === 0 && session.promptSuggestion && 'is-agent')}
                        onClick={() => (s.prompt === '/undo' ? onRollback(undefined, 'undo_last') : onInsertPrompt(s.prompt))}
                        title={s.tooltip}
                      >
                        {s.prompt === '/undo' && <Icon name="undo" size={12} />}
                        {i === 0 && session.promptSuggestion && <Icon name="sparkles" size={12} />}
                        {s.label}
                      </button>
                    ))}
                  </div>
                )
              )}
            </div>
          )}
        </div>
      </div>

      {showJump && (
        <button type="button" className="ws-jump" onClick={jumpToLatest}>
          <Icon name="arrowUp" size={13} className="ws-jump-icon" />
          Jump to latest
        </button>
      )}
    </div>
  );
};
