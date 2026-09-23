import type { Session } from '../../../server/types';
import { cacheExpiresAt, clockTime, formatLeft, formatTokens } from '../util';

interface Props {
  /** Sessions whose cache is about to expire, soonest first — see cacheExpiring. */
  sessions: Session[];
  now: number;
  /** Terminal ids with a /compact already sent, so the button can say so. */
  sent: Set<string>;
  onCompact: (s: Session) => void;
  onKeepWarm: (s: Session) => void;
  onSelect: (s: Session) => void;
  onDismiss: () => void;
}

/**
 * Running sessions whose prompt cache is about to expire, with the two things
 * worth doing about it while it is still there.
 *
 * Keep warm, if you are coming back: a one-line ping before the hour is up
 * reads the cache instead of letting it lapse. Compact, if you are not coming
 * back soon: summarising now reads the context at cache prices, and what you
 * come back to is small enough that its rebuild barely costs anything. After
 * the cache has gone, both are too late, which is why nothing expired is here.
 */
export function CacheAlertBar({
  sessions, now, sent, onCompact, onKeepWarm, onSelect, onDismiss,
}: Props): JSX.Element {
  const first = cacheExpiresAt(sessions[0]) ?? now;
  const headline = sessions.length === 1
    ? `Cache expires in ${formatLeft(first - now)}`
    : `${sessions.length} caches expire soon`;

  return (
    <div className="alert-bar cache" role="status" style={{ ['--alert-color' as string]: 'var(--warm)' }}>
      <span className="alert-icon" aria-hidden>⏱</span>
      <div className="alert-text">
        <strong>{headline}</strong>
        <span className="alert-detail">
          The next turn after that rewrites the whole context. Keep it warm, or compact it while that is cheap.
        </span>
      </div>

      <div className="alert-cands">
        <div className="alert-cands-list">
          {sessions.map((s) => {
            const done = s.termId !== null && sent.has(s.termId);
            const at = cacheExpiresAt(s) ?? now;
            return (
              <span key={s.id} className="alert-cand">
                <button
                  className="alert-cand-name"
                  onClick={() => onSelect(s)}
                  title={`${s.title} — ${s.contextTokens.toLocaleString()} tokens of context; cache expires at ${clockTime(at, now)}. Click to select it.`}
                >
                  <span className="alert-cand-title">{s.title}</span>
                  <span className="alert-cand-ctx">{formatTokens(s.contextTokens)}</span>
                  <span className="alert-cand-left">{formatLeft(at - now)}</span>
                </button>
                {s.attached ? (
                  <>
                    <button
                      className="btn sm"
                      onClick={() => onKeepWarm(s)}
                      title="Keep this session's cache warm for the next 2 hours: a one-line ping before each hour is up, only while it is idle"
                    >
                      Keep warm
                    </button>
                    <button
                      className="btn sm"
                      disabled={done}
                      onClick={() => onCompact(s)}
                      title={done
                        ? '/compact has been sent to this session'
                        : 'Type /compact at this session’s prompt, while the cache still makes reading the context cheap'}
                    >
                      {done ? '✓ Sent' : 'Compact'}
                    </button>
                  </>
                ) : (
                  // Running in a terminal of your own, so there is nothing here
                  // to type into.
                  <span
                    className="alert-cand-note"
                    title="Running in your own terminal — act on it there, or reopen it here"
                  >
                    elsewhere
                  </span>
                )}
              </span>
            );
          })}
        </div>
      </div>

      <button className="btn sm" style={{ marginLeft: 'auto', flex: 'none' }} onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
