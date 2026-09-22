import type { Session } from '../../../server/types';
import type { UsageAlert } from '../alerts';
import { compactionCandidates, formatTokens, usageColor } from '../util';

interface Props {
  alert: UsageAlert;
  /** Every session, unfiltered — the bar picks its own candidates. */
  sessions: Session[];
  /** Context size, in tokens, above which a session is worth offering. */
  compactAbove: number;
  /** Terminal ids with a /compact already sent, so the button can say so. */
  sent: Set<string>;
  onCompact: (s: Session) => void;
  onSelect: (s: Session) => void;
  onDismiss: () => void;
}

/**
 * One usage alert, across the top of the window, with the thing you would
 * actually do about it attached to it.
 *
 * The pairing is the point. A warning that a window is 80% spent tells you to
 * be careful and leaves you to work out how; the sessions carrying the most
 * context are the answer to "careful about what", and they are sitting right
 * here in the same app. Anywhere else this would be two features.
 */
export function UsageAlertBar({
  alert, sessions, compactAbove, sent, onCompact, onSelect, onDismiss,
}: Props): JSX.Element {
  const candidates = compactionCandidates(sessions, compactAbove);
  const colour = alert.kind === 'threshold' ? usageColor(alert.percent) : 'var(--accent)';

  return (
    <div className="alert-bar" role="status" style={{ ['--alert-color' as string]: colour }}>
      <span className="alert-icon" aria-hidden>{alert.kind === 'threshold' ? '⚠' : '↻'}</span>
      <div className="alert-text">
        <strong>{alert.headline}</strong>
        <span className="alert-detail">{alert.detail}</span>
      </div>

      {/* Nothing when no running session is carrying much — which is the
          honest answer, and a better one than a list of sessions you would
          have to resume before compacting them could save you anything. */}
      {candidates.length > 0 && (
        <div className="alert-cands">
          <span className="alert-cands-label">Heaviest running</span>
          <div className="alert-cands-list">
            {candidates.map((s) => {
              const done = s.termId !== null && sent.has(s.termId);
              return (
                <span key={s.id} className="alert-cand">
                  <button
                    className="alert-cand-name"
                    onClick={() => onSelect(s)}
                    title={`${s.title} — ${s.contextTokens.toLocaleString()} tokens of context. Click to select it.`}
                  >
                    {/* The title gets its own box so it is the thing that
                        ellipsises. Left as a bare text node it pushed the token
                        count — the reason the row is here at all — out of the
                        overflow entirely on exactly the long names that need
                        truncating. */}
                    <span className="alert-cand-title">{s.title}</span>
                    <span className="alert-cand-ctx">{formatTokens(s.contextTokens)}</span>
                  </button>
                  {s.attached ? (
                    <button
                      className="btn sm"
                      disabled={done}
                      onClick={() => onCompact(s)}
                      title={done
                        ? '/compact has been sent to this session'
                        : 'Type /compact at this session’s prompt. Claude Code summarises the conversation so far and drops the rest.'}
                    >
                      {done ? '✓ Sent' : 'Compact'}
                    </button>
                  ) : (
                    // Running, but in a terminal of your own rather than one of
                    // ours, so there is nothing here to type into. Saying so
                    // beats a disabled button that looks like it might work.
                    <span
                      className="alert-cand-note"
                      title="Running in your own terminal — compact it there, or reopen it here"
                    >
                      elsewhere
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        </div>
      )}

      <button className="btn sm" style={{ marginLeft: 'auto', flex: 'none' }} onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
