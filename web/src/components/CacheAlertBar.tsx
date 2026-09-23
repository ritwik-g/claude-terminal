import type { Session } from '../../../server/types';
import { cacheExpiresAt, clockTime, formatLeft, formatTokens } from '../util';

interface Props {
  /** Sessions with a warm cache worth acting on — see cacheExpiring and breakCandidates. */
  sessions: Session[];
  /** Defaults to the expiry warning's own: when the first cache expires. */
  headline?: string;
  detail?: string;
  /**
   * How long the Keep warm button keeps a session warm, in minutes, or null to
   * leave the button out (the end-of-day reminder: nothing is worth pinging
   * until the morning).
   */
  keepWarmMinutes?: number | null;
  /** Icon at the start of the bar. */
  icon?: string;
  now: number;
  /** Terminal ids with a /compact already sent, so the button can say so. */
  sent: Set<string>;
  onCompact: (s: Session) => void;
  /** Called for the Keep warm button, with the session; the caller knows the duration. */
  onKeepWarm: (s: Session) => void;
  onSelect: (s: Session) => void;
  onDismiss: () => void;
}

/**
 * Running sessions whose prompt cache is about to expire, or that you are about
 * to walk away from (a break reminder), with the two things worth doing about
 * it while the cache is still there.
 *
 * Keep warm, if you are coming back: a one-line ping before the hour is up
 * reads the cache instead of letting it lapse. Compact, if you are not coming
 * back soon: summarising now reads the context at cache prices, and what you
 * come back to is small enough that its rebuild barely costs anything. After
 * the cache has gone, both are too late, which is why nothing expired is here.
 */
export function CacheAlertBar({
  sessions, headline, detail, keepWarmMinutes = 120, icon = '⏱', now, sent, onCompact, onKeepWarm, onSelect,
  onDismiss,
}: Props): JSX.Element {
  const first = cacheExpiresAt(sessions[0]) ?? now;
  const title = headline ?? (sessions.length === 1
    ? `Cache expires in ${formatLeft(first - now)}`
    : `${sessions.length} caches expire soon`);
  const hours = keepWarmMinutes ? Math.round(keepWarmMinutes / 60) : 0;

  return (
    <div className="alert-bar cache" role="status" style={{ ['--alert-color' as string]: 'var(--warm)' }}>
      <span className="alert-icon" aria-hidden>{icon}</span>
      <div className="alert-text">
        <strong>{title}</strong>
        <span className="alert-detail">
          {detail ?? 'The next turn after that rewrites the whole context. Keep it warm, or compact it while that is cheap.'}
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
                  title={`${s.title} — ${s.contextTokens.toLocaleString()} tokens of context; cache expires at ${clockTime(at, now)}` +
                    `${s.keepWarm?.active ? ' (kept warm, but not overnight)' : ''}. Click to select it.`}
                >
                  <span className="alert-cand-title">{s.title}</span>
                  <span className="alert-cand-ctx">{formatTokens(s.contextTokens)}</span>
                  <span className="alert-cand-left">{formatLeft(at - now)}</span>
                </button>
                {s.attached ? (
                  <>
                    {keepWarmMinutes ? (
                      <button
                        className="btn sm"
                        disabled={s.keepWarm?.active}
                        onClick={() => onKeepWarm(s)}
                        title={`Keep this session's cache warm for the next ${hours} hour${hours === 1 ? '' : 's'}: a one-line ping before each hour is up, only while it is idle`}
                      >
                        Keep warm
                      </button>
                    ) : null}
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
