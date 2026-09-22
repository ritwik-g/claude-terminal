import { useEffect, useRef, useState } from 'react';
import { clockTime, relTime, resetsIn, usageColor, windowExpired } from '../util';
import type { UsageState } from '../useUsage';
import type { UsageWindow } from '../../../server/usage';

/**
 * How long the pointer must rest on the pill before the panel opens.
 *
 * The pill sits in the header among buttons you cross on the way to somewhere
 * else, and a panel that appears the instant the pointer touches it would
 * cover the list every time you reach for + New.
 */
const HOVER_OPEN_MS = 220;

/** One window's block in the detail panel: name, bar, percent, and when it ends. */
function WindowRow({ label, w, now }: { label: string; w: UsageWindow; now: number }): JSX.Element {
  const gone = windowExpired(w, now);
  return (
    <div className="usage-win">
      <div className="usage-win-head">
        <span className="usage-win-name">{label}</span>
        <span className="usage-win-pct" style={{ color: gone ? 'var(--fg-dim)' : usageColor(w.percent) }}>
          {w.percent}%
        </span>
      </div>
      <span className="usage-bar wide" aria-hidden>
        <span
          className="usage-fill"
          style={{
            width: `${w.percent}%`,
            background: gone ? 'var(--fg-faint)' : usageColor(w.percent),
          }}
        />
      </span>
      <div className="usage-win-when">
        {gone
          ? 'That window has since reset — this figure is from the old one'
          : `resets ${clockTime(w.resetsAt, now)} · in ${resetsIn(w.resetsAt, now)}`}
      </div>
    </div>
  );
}

/**
 * The account-wide usage windows.
 *
 * They belong up here rather than on a session row because they are not a
 * property of any one session: every session on the account draws from the
 * same windows, on this machine and any other.
 *
 * The numbers arrive as a prop rather than being fetched here, because the
 * alerts watch the same ones — see useUsage.
 */
export function UsagePill({ state, now: appNow }: { state: UsageState; now: number }): JSX.Element | null {
  const { usage, meta, lost, busy, refresh } = state;
  // Two ways in, and they must not fight: hovering opens the panel while the
  // pointer is there, clicking holds it open until you dismiss it. `open` is
  // either one, so moving the pointer away from a panel you clicked open does
  // not close it out from under the button you were reaching for.
  const [hovering, setHovering] = useState(false);
  const [held, setHeld] = useState(false);
  const hoverTimer = useRef<number | null>(null);
  const open = hovering || held;

  /**
   * A second-by-second clock, but only while the panel is open.
   *
   * The app's clock ticks every 30s, which is right for a list of ages but
   * leaves a countdown reading 'in 4h 36m' sitting unchanged for most of a
   * minute in front of someone watching it. Closed, the panel is not on screen
   * to be watched and a re-render a second is not worth paying for.
   */
  const [fastNow, setFastNow] = useState(appNow);
  useEffect(() => {
    if (!open) return;
    setFastNow(Date.now());
    const iv = setInterval(() => setFastNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [open]);
  const now = open ? fastNow : appNow;

  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);

  // Escape closes a panel held open by a click — the same key that dismisses
  // every other transient surface in the app.
  useEffect(() => {
    if (!held) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setHeld(false);
    };
    // Capture, so this runs before App's own Escape handler clears the search.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [held]);

  const cancelHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  const enter = () => {
    cancelHover();
    hoverTimer.current = window.setTimeout(() => setHovering(true), HOVER_OPEN_MS);
  };
  const leave = () => {
    cancelHover();
    setHovering(false);
  };
  // Clicking hands the panel over to `held`, so the pending hover must not fire
  // afterwards and leave a panel that a second click cannot close.
  const toggleHeld = () => {
    cancelHover();
    setHovering(false);
    setHeld((v) => !v);
  };

  // Nothing cached and nothing fetched yet — say nothing rather than guess.
  if (!usage?.fiveHour) return null;

  const { percent, resetsAt } = usage.fiveHour;
  // Both conditions mean the same thing to a reader — do not act on this number
  // — so they get the same dimmed treatment rather than two shades of doubt.
  const gone = windowExpired(usage.fiveHour, now);
  const doubtful = usage.stale || gone || lost;
  const running = busy || meta.refreshing;
  // Refreshing inside Claude Code's own 5-minute throttle writes nothing, so
  // the probe has no way to tell success from failure and simply times out —
  // 45 seconds of a Claude Code process started for nothing. Say so instead.
  const throttled = !running && !meta.refreshable && meta.refreshableAt !== null;
  const refreshHint = running
    ? 'Refreshing — this starts a short Claude Code session to fetch current numbers'
    : throttled
      ? `Claude Code only rewrites these numbers every 5 minutes. Refreshable ${clockTime(meta.refreshableAt, now)}.`
      : 'Refresh now — starts a short Claude Code session to fetch current numbers';

  return (
    <div className="usage-group" onMouseEnter={enter} onMouseLeave={leave}>
      {/* Only for the clicked-open panel. A hover panel is dismissed by moving
          away, and a scrim over the whole window would swallow the first click
          of whatever you moved to. */}
      {held && <div className="scrim" onClick={() => setHeld(false)} />}
      <button
        className={`usage-pill${doubtful ? ' stale' : ''}${running ? ' busy' : ''}${open ? ' open' : ''}`}
        onClick={toggleHeld}
        aria-expanded={open}
        aria-label={
          gone
            ? `Usage: ${percent}% when last checked, and that 5-hour window has since reset. Show details`
            : `Usage: ${percent}% of the 5-hour window used, resets at ${clockTime(resetsAt, now)}. Show details`
        }
        title={open ? undefined : 'Show the full limits'}
      >
        <span className="usage-bar" aria-hidden>
          <span
            className="usage-fill"
            style={{ width: `${percent}%`, background: usageColor(percent) }}
          />
        </span>
        <span className="usage-pct">{percent}%</span>
        {/* The wall-clock reset time, not a countdown: it is what you compare
            against your own afternoon, and it does not silently go wrong while
            the tab sits in the background. Once the window has rolled over
            there is no reset to name — a time that passed hours ago is worse
            than saying nothing. */}
        <span className="usage-reset">
          {gone ? 'out of date' : `resets ${clockTime(resetsAt, now)}`}
        </span>
      </button>
      {/* Its own control rather than the pill's click, which now belongs to the
          detail panel. Refreshing is not free — it starts a real Claude Code
          session — so it should take a deliberate press on a button that says
          what it is, not a click anywhere on a status readout. */}
      <button
        className={`usage-refresh${running ? ' spin' : ''}`}
        onClick={() => void refresh(true)}
        disabled={running || throttled}
        title={refreshHint}
        aria-label={refreshHint}
      >
        {'↻'}
      </button>
      {open && (
        <div className="usage-pop" role="group" aria-label="Usage limits">
          {lost && (
            <div className="usage-note warn">
              Claude Code cleared its usage cache — it does that on login and logout.
              These are the last numbers it had.
            </div>
          )}
          {usage.fiveHour && <WindowRow label="5-hour window" w={usage.fiveHour} now={now} />}
          {usage.weekly && <WindowRow label="This week" w={usage.weekly} now={now} />}
          <div className="usage-pop-foot">
            <span className={usage.stale || gone ? 'usage-age old' : 'usage-age'}>
              {usage.stale || gone
                ? `Checked ${relTime(usage.fetchedAt, now)} ago — too old to trust`
                : `Checked ${relTime(usage.fetchedAt, now)} ago`}
            </span>
            <button
              className="btn sm"
              onClick={() => void refresh(true)}
              disabled={running || throttled}
              title={refreshHint}
            >
              {running ? 'Refreshing…' : 'Refresh now'}
            </button>
          </div>
          {throttled && (
            <div className="usage-note">
              Claude Code rewrites these numbers at most every 5 minutes.
              Refreshable {clockTime(meta.refreshableAt, now)}.
            </div>
          )}
          <div className="usage-note">
            Shared across every Claude Code session on this account, not just this app.
          </div>
        </div>
      )}
    </div>
  );
}
