import type { UsageAlert } from '../alerts';
import { usageColor } from '../util';

interface Props {
  alert: UsageAlert;
  onDismiss: () => void;
}

/**
 * One usage alert, across the top of the window.
 *
 * It used to carry the heaviest running sessions with a Compact button each.
 * That moved to the cache bar (CacheAlertBar): whether compacting is cheap
 * depends on whether the session's prompt cache is still there — while it is,
 * a compact reads the context at a tenth of the price; once it has expired,
 * compacting costs a full rewrite of its own — and the usage window says
 * nothing about that.
 */
export function UsageAlertBar({ alert, onDismiss }: Props): JSX.Element {
  const colour = alert.kind === 'threshold' ? usageColor(alert.percent) : 'var(--accent)';

  return (
    <div className="alert-bar" role="status" style={{ ['--alert-color' as string]: colour }}>
      <span className="alert-icon" aria-hidden>{alert.kind === 'threshold' ? '⚠' : '↻'}</span>
      <div className="alert-text">
        <strong>{alert.headline}</strong>
        <span className="alert-detail">{alert.detail}</span>
      </div>
      <button className="btn sm" style={{ marginLeft: 'auto', flex: 'none' }} onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
