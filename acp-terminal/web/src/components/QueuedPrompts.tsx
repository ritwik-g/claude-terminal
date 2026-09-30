import React, { useState } from 'react';
import type { AcpSession, QueuedPrompt } from '../types';
import { api } from '../api';
import { Button, Icon, IconButton } from '../ui';
import { MOD_KEY } from './Sidebar';
import { isCompacting } from './CompactionCard';

/**
 * Messages waiting behind the running turn, above the composer. The first goes out when the
 * turn ends cleanly; a stopped or failed turn pauses the queue until one is sent by hand.
 */
export const QueuedPrompts: React.FC<{ session: AcpSession; onRefresh: () => void }> = ({ session, onRefresh }) => {
  const queue = session.queuedPrompts || [];
  // 'blocked' is a turn waiting on an approval, and a compaction runs like a turn: neither pauses the queue
  const compacting = isCompacting(session);
  const paused = session.state !== 'working' && session.state !== 'blocked' && !compacting;

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err: any) {
      alert(err.message);
    } finally {
      onRefresh();
    }
  };

  return (
    <section className="ws-queue" aria-label="Queued messages">
      <div className="ws-queue-head">
        <Icon name={paused ? 'pause' : 'clock'} size={13} />
        <span>
          {paused
            ? `${queue.length} queued, paused because the last turn didn't finish`
            : compacting
            ? `${queue.length} queued, sent one at a time once compaction finishes`
            : `${queue.length} queued, sent one at a time when the agent finishes`}
        </span>
        {paused && (
          <Button size="sm" variant="secondary" icon="send" onClick={() => act(() => api.sendQueuedNow(session.id, queue[0].id))}>
            Send next
          </Button>
        )}
      </div>
      <ol className="ws-queue-list">
        {queue.map((q) => (
          <QueuedRow key={q.id} sessionId={session.id} item={q} working={!paused} act={act} />
        ))}
      </ol>
    </section>
  );
};

const QueuedRow: React.FC<{
  sessionId: string;
  item: QueuedPrompt;
  working: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}> = ({ sessionId, item, working, act }) => {
  const [draft, setDraft] = useState<string | null>(null);
  const files = item.attachments?.length || 0;

  const save = () => {
    const text = draft?.trim();
    setDraft(null);
    if (text && text !== item.text) void act(() => api.updateQueuedPrompt(sessionId, item.id, text));
  };

  return (
    <li className="ws-queue-item">
      {draft !== null ? (
        <textarea
          className="ws-queue-edit"
          value={draft}
          autoFocus
          rows={Math.min(6, draft.split('\n').length + 1)}
          aria-label="Edit queued message"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setDraft(null);
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              save();
            }
          }}
        />
      ) : (
        <button type="button" className="ws-queue-text" title={`Edit (${MOD_KEY} Enter saves)`} onClick={() => setDraft(item.text)}>
          {item.text || <em>Attachments only</em>}
          {files > 0 && (
            <span className="ws-queue-files">
              <Icon name="paperclip" size={11} />
              {files}
            </span>
          )}
        </button>
      )}
      <div className="ws-queue-actions">
        <IconButton
          icon="send"
          size="sm"
          label={working ? 'Stop the current turn and send this now' : 'Send this now'}
          onClick={() => act(() => api.sendQueuedNow(sessionId, item.id))}
        />
        <IconButton icon="x" size="sm" label="Remove from queue" onClick={() => act(() => api.removeQueuedPrompt(sessionId, item.id))} />
      </div>
    </li>
  );
};
