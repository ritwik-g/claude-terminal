import React, { useState } from 'react';
import type { AcpSession, AutoCompactSetting, CompactionRecord, TurnMessage } from '../types';
import { api } from '../api';
import { Icon, Spinner } from '../ui';
import { MarkdownContent } from './MarkdownContent';
import { cx, formatTime } from './sessionMeta';
import '../styles/compaction.css';

const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

function title(c: CompactionRecord): string {
  switch (c.status) {
    case 'running':
      return 'Compacting context…';
    case 'completed':
      return 'Context compacted';
    case 'cancelled':
      return 'Compaction stopped';
    default:
      return 'Compaction failed';
  }
}

function detail(c: CompactionRecord): string | null {
  if (c.status === 'running') {
    return c.method === 'native' ? 'The agent is summarising the conversation so far' : 'Asking the agent for a handoff summary';
  }
  if (c.status === 'failed') return c.error || null;
  if (c.status === 'completed' && c.preTokens && c.postTokens !== undefined) {
    return `${kTokens(c.preTokens)} → ${c.postTokensEstimated ? '~' : ''}${kTokens(c.postTokens)} tokens`;
  }
  return null;
}

const TRIGGER_LABEL: Record<CompactionRecord['trigger'], string | null> = {
  manual: null,
  auto: 'Automatic',
  agent: 'Started by the agent',
};

/**
 * The divider a compaction leaves in the transcript. Turns above it stay for the reader;
 * the agent carries on from the summary, which opens from here.
 */
export const CompactionCard: React.FC<{ turn: TurnMessage }> = ({ turn }) => {
  const c = turn.compaction!;
  const [open, setOpen] = useState(false);
  const trigger = TRIGGER_LABEL[c.trigger];
  const info = detail(c);
  const tone = c.status === 'failed' ? 'danger' : c.status === 'completed' ? 'accent' : 'neutral';

  return (
    <div className={cx('ws-compaction', `is-${c.status}`)} role="note" aria-live={c.status === 'running' ? 'polite' : undefined}>
      <div className="ws-compaction-rule">
        <div
          className={cx('ws-compaction-pill', `tone-${tone}`)}
          title={
            c.status === 'completed'
              ? 'Earlier messages stay here for you to read; the agent works from the summary from now on.'
              : undefined
          }
        >
          {c.status === 'running' ? <Spinner size={12} /> : <Icon name={c.status === 'failed' ? 'alert' : 'archive'} size={13} />}
          <span className="ws-compaction-title">{title(c)}</span>
          {info && <span className="ws-compaction-detail">{info}</span>}
          {trigger && <span className="ws-compaction-trigger">{trigger}</span>}
          <time className="ws-compaction-time" dateTime={new Date(turn.timestamp).toISOString()}>
            {formatTime(turn.timestamp)}
          </time>
          {c.summary && c.status === 'completed' && (
            <button
              type="button"
              className="ws-compaction-toggle"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? 'Hide summary' : 'Show summary'}
              <Icon name={open ? 'chevronUp' : 'chevronDown'} size={12} />
            </button>
          )}
        </div>
      </div>
      {open && c.summary && (
        <div className="ws-compaction-summary">
          <MarkdownContent content={c.summary} />
        </div>
      )}
    </div>
  );
};

export const AUTO_COMPACT_THRESHOLDS = [30, 50, 70] as const;
const DEFAULT_THRESHOLD = 50;

const AUTO_COMPACT_TIP =
  'When a run ends and no messages are queued, ask the agent to compact its context once it is over this share of its window. ' +
  'The next run then starts lean instead of reloading the whole conversation. Earlier messages stay here for you to read.';

/** "Compact when finished": a checkbox and the threshold it applies above. */
export const AutoCompactControl: React.FC<{
  session: AcpSession;
  onChanged: (setting: AutoCompactSetting) => void;
  /** A second line under it, for the mobile action sheet. */
  description?: string;
  className?: string;
}> = ({ session, onChanged, description, className }) => {
  const current: AutoCompactSetting = session.autoCompact ?? { enabled: false, thresholdPercent: DEFAULT_THRESHOLD };
  const [saving, setSaving] = useState(false);

  const save = async (next: AutoCompactSetting) => {
    setSaving(true);
    try {
      await api.setAutoCompact(session.id, next);
      onChanged(next);
    } catch (err: any) {
      alert(`Could not change "Compact when finished": ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={cx('ws-autocompact', current.enabled && 'is-on', className)} title={AUTO_COMPACT_TIP}>
      <label className="ws-autocompact-check">
        <input
          type="checkbox"
          checked={current.enabled}
          disabled={saving}
          onChange={(e) => save({ ...current, enabled: e.target.checked })}
        />
        <span>Compact when finished</span>
      </label>
      <select
        className="ws-autocompact-threshold"
        aria-label="Compact when context is over"
        value={current.thresholdPercent}
        disabled={saving}
        onChange={(e) => save({ ...current, thresholdPercent: Number(e.target.value) })}
      >
        {AUTO_COMPACT_THRESHOLDS.map((t) => (
          <option key={t} value={t}>
            when over {t}%
          </option>
        ))}
        {!AUTO_COMPACT_THRESHOLDS.includes(current.thresholdPercent as (typeof AUTO_COMPACT_THRESHOLDS)[number]) && (
          <option value={current.thresholdPercent}>when over {current.thresholdPercent}%</option>
        )}
      </select>
      {description && <span className="ws-autocompact-desc">{description}</span>}
    </div>
  );
};

/** True while the session is compacting, from the running compaction's card. */
export function isCompacting(session: AcpSession): boolean {
  for (let i = session.turns.length - 1; i >= 0; i--) {
    const c = session.turns[i].compaction;
    if (c) return c.status === 'running';
  }
  return false;
}
