import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { relTime } from '../util';
import type { UsageSnapshot } from '../../../server/usage';

/**
 * How often we ask Claude Code for current numbers. Its own cache is only
 * rewritten every 5 minutes, so anything under that is spent effort; 10 keeps
 * the figure current enough to act on while halving the number of throwaway
 * sessions started in a working day.
 */
const REFRESH_MS = 10 * 60 * 1000;

/** Re-reading the cached file is free, so notice refreshes from elsewhere. */
const POLL_MS = 30 * 1000;

/** Amber once the window is worth watching, red once it is worth planning around. */
function colorFor(percent: number): string {
  if (percent >= 90) return 'var(--st-crashed)';
  if (percent >= 70) return 'var(--st-needs)';
  return 'var(--st-working)';
}

function resetsIn(at: number | null, now: number): string {
  if (at === null) return 'unknown';
  const mins = Math.round((at - now) / 60_000);
  if (mins <= 0) return 'any moment';
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function tooltip(u: UsageSnapshot, now: number): string {
  const lines: string[] = [];
  if (u.fiveHour) {
    lines.push(`5-hour window: ${u.fiveHour.percent}% used, resets in ${resetsIn(u.fiveHour.resetsAt, now)}`);
  }
  if (u.weekly) {
    lines.push(`This week: ${u.weekly.percent}% used, resets in ${resetsIn(u.weekly.resetsAt, now)}`);
  }
  lines.push('');
  lines.push(
    u.stale
      ? `Last checked ${relTime(u.fetchedAt, now)} ago — too old to trust. Click to refresh.`
      : `Checked ${relTime(u.fetchedAt, now)} ago. Click to refresh now.`,
  );
  lines.push('Shared across every Claude Code session on this account, not just this app.');
  return lines.join('\n');
}

/**
 * The account-wide 5-hour usage window.
 *
 * It belongs up here rather than on a session row because it is not a property
 * of any one session: every session on the account draws from the same window,
 * on this machine and any other.
 */
export function UsagePill(): JSX.Element | null {
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Refs, not state: the polling effect reads both, and as state they would be
  // dependencies of it — so every refresh would tear down and re-arm the
  // interval, and the elapsed time it is measuring would reset with it.
  const busyRef = useRef(false);
  const lastTried = useRef(0);

  const refresh = useCallback(async (force: boolean) => {
    if (busyRef.current) return;
    // Failed probes are rate-limited too, or a machine that cannot refresh at
    // all would start a doomed session on every interval.
    if (!force && Date.now() - lastTried.current < REFRESH_MS) return;
    busyRef.current = true;
    lastTried.current = Date.now();
    setBusy(true);
    try {
      const res = await api.refreshUsage();
      setUsage(res.usage);
    } catch {
      // Leave the last good numbers on screen; their age is already visible.
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;

    const read = async () => {
      try {
        const res = await api.usage();
        if (alive) setUsage(res.usage);
      } catch {
        /* the server is down; the rest of the app will say so */
      }
    };

    const tick = () => {
      setNow(Date.now());
      void read();
      // Only while the window is on screen: a minimised app that keeps starting
      // Claude Code sessions is spending the user's quota to tell them about
      // their quota.
      if (document.visibilityState === 'visible') void refresh(false);
    };

    void tick();
    const iv = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      alive = false;
      clearInterval(iv);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [refresh]);

  // Nothing cached and nothing fetched yet — say nothing rather than guess.
  if (!usage?.fiveHour) return null;

  const { percent, resetsAt } = usage.fiveHour;
  return (
    <button
      className={`usage-pill${usage.stale ? ' stale' : ''}${busy ? ' busy' : ''}`}
      onClick={() => void refresh(true)}
      title={tooltip(usage, now)}
      aria-label={`Usage: ${percent}% of the 5-hour window used, resets in ${resetsIn(resetsAt, now)}`}
    >
      <span className="usage-bar" aria-hidden>
        <span
          className="usage-fill"
          style={{ width: `${percent}%`, background: colorFor(percent) }}
        />
      </span>
      <span className="usage-pct">{percent}%</span>
      {/* Named, not just a duration: beside a percentage a bare "1h 59m" reads
          as time spent rather than time left. */}
      <span className="usage-reset">resets {resetsIn(resetsAt, now)}</span>
    </button>
  );
}
