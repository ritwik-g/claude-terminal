import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type UsagePayload } from '../api';
import { relTime } from '../util';
import type { UsageSnapshot, UsageWindow } from '../../../server/usage';

/**
 * How often we ask Claude Code for current numbers. Its own cache is only
 * rewritten every 5 minutes, so anything under that is spent effort; 10 keeps
 * the figure current enough to act on while halving the number of throwaway
 * sessions started in a working day.
 */
const REFRESH_MS = 10 * 60 * 1000;

/**
 * Retry interval while there is no cache at all. Claude Code deletes it on
 * every login and logout, and waiting the full REFRESH_MS to put it back made
 * the pill vanish for ten minutes with no explanation.
 */
const MISSING_RETRY_MS = 60 * 1000;

/** Re-reading the cached file is free, so notice refreshes from elsewhere. */
const POLL_MS = 30 * 1000;

/**
 * How long the pointer must rest on the pill before the panel opens.
 *
 * The pill sits in the header among buttons you cross on the way to somewhere
 * else, and a panel that appears the instant the pointer touches it would
 * cover the list every time you reach for + New.
 */
const HOVER_OPEN_MS = 220;

/** Amber once the window is worth watching, red once it is worth planning around. */
function colorFor(percent: number): string {
  if (percent >= 90) return 'var(--st-crashed)';
  if (percent >= 70) return 'var(--st-needs)';
  return 'var(--st-working)';
}

const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const WEEKDAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const DATE_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

/** Whole calendar days from `now` to `at`, DST-safe because it compares midnights. */
function dayOffset(at: number, now: number): number {
  const a = new Date(at);
  const b = new Date(now);
  a.setHours(0, 0, 0, 0);
  b.setHours(0, 0, 0, 0);
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}

/**
 * The wall-clock time a window rolls over — the thing you actually plan around.
 *
 * A countdown makes you do arithmetic against your own calendar to answer "is
 * it back before my 3pm?", and it is wrong the moment you look away. The date
 * part appears only when the reset is not today, because "2:20 PM" for
 * something four hours out needs no qualification and "Mon 2:20 PM" for
 * something four hours out is noise.
 */
function clockTime(at: number | null, now: number): string {
  if (at === null) return 'unknown';
  const time = TIME_FMT.format(at);
  const days = dayOffset(at, now);
  if (days <= 0) return time;
  if (days === 1) return `${time} tomorrow`;
  // Past a week a weekday name is ambiguous — "Tue" could be either one.
  if (days < 7) return `${WEEKDAY_FMT.format(at)} ${time}`;
  return `${DATE_FMT.format(at)} ${time}`;
}

function resetsIn(at: number | null, now: number): string {
  if (at === null) return 'unknown';
  const mins = Math.round((at - now) / 60_000);
  if (mins <= 0) return 'any moment';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  // The weekly window is days away, and "102h 17m" makes the reader do the
  // division. Minutes stop being interesting long before that.
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return `${hours}h ${mins % 60}m`;
}

/**
 * Whether the window this reading describes has already rolled over.
 *
 * The percentage is only meaningful until its own reset time; past that the
 * window emptied and started again, so the number is not merely old, it is
 * about a window that no longer exists. This is a sharper test than the
 * one-hour staleness rule and independent of it — a reading taken twenty
 * minutes ago is not stale, but if its reset fell ten minutes ago the figure
 * is still describing the wrong window.
 */
function expired(w: UsageWindow, now: number): boolean {
  return w.resetsAt !== null && w.resetsAt <= now;
}

/** One window's block in the detail panel: name, bar, percent, and when it ends. */
function WindowRow({ label, w, now }: { label: string; w: UsageWindow; now: number }): JSX.Element {
  const gone = expired(w, now);
  return (
    <div className="usage-win">
      <div className="usage-win-head">
        <span className="usage-win-name">{label}</span>
        <span className="usage-win-pct" style={{ color: gone ? 'var(--fg-dim)' : colorFor(w.percent) }}>
          {w.percent}%
        </span>
      </div>
      <span className="usage-bar wide" aria-hidden>
        <span
          className="usage-fill"
          style={{
            width: `${w.percent}%`,
            background: gone ? 'var(--fg-faint)' : colorFor(w.percent),
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
 */
export function UsagePill(): JSX.Element | null {
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  // What the server says about refreshing, kept beside the numbers so the
  // refresh button can be honest about whether pressing it would do anything.
  const [meta, setMeta] = useState<{ refreshing: boolean; refreshable: boolean; refreshableAt: number | null }>(
    { refreshing: false, refreshable: true, refreshableAt: null },
  );
  // The cache vanished after we had numbers. Keep showing them, dimmed, rather
  // than dropping the pill out of the header without a word.
  const [lost, setLost] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Two ways in, and they must not fight: hovering opens the panel while the
  // pointer is there, clicking holds it open until you dismiss it. `open` is
  // either one, so moving the pointer away from a panel you clicked open does
  // not close it out from under the button you were reaching for.
  const [hovering, setHovering] = useState(false);
  const [held, setHeld] = useState(false);
  const hoverTimer = useRef<number | null>(null);
  const open = hovering || held;
  // Refs, not state: the polling effect reads both, and as state they would be
  // dependencies of it — so every refresh would tear down and re-arm the
  // interval, and the elapsed time it is measuring would reset with it.
  const busyRef = useRef(false);
  const lastTried = useRef(0);

  const accept = useCallback((res: UsagePayload) => {
    setMeta({
      refreshing: res.refreshing,
      refreshable: res.refreshable ?? true,
      refreshableAt: res.refreshableAt ?? null,
    });
    if (res.usage) {
      setUsage(res.usage);
      setLost(false);
    } else {
      setLost(true);
    }
  }, []);

  const refresh = useCallback(async (force: boolean, gap = REFRESH_MS) => {
    if (busyRef.current) return;
    // Failed probes are rate-limited too, or a machine that cannot refresh at
    // all would start a doomed session on every interval.
    if (!force && Date.now() - lastTried.current < gap) return;
    busyRef.current = true;
    lastTried.current = Date.now();
    setBusy(true);
    try {
      accept(await api.refreshUsage());
    } catch {
      // Leave the last good numbers on screen; their age is already visible.
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [accept]);

  useEffect(() => {
    let alive = true;

    /** Resolves to whether a cache exists, or null when the server is unreachable. */
    const read = async (): Promise<boolean | null> => {
      try {
        const res = await api.usage();
        if (alive) accept(res);
        return res.usage !== null;
      } catch {
        /* the server is down; the rest of the app will say so */
        return null;
      }
    };

    const tick = async () => {
      setNow(Date.now());
      const present = await read();
      if (!alive || present === null) return;
      // Only while the window is on screen: a minimised app that keeps starting
      // Claude Code sessions is spending the user's quota to tell them about
      // their quota.
      if (document.visibilityState === 'visible') {
        void refresh(false, present ? REFRESH_MS : MISSING_RETRY_MS);
      }
    };

    const run = () => { void tick(); };
    run();
    const iv = setInterval(run, POLL_MS);
    document.addEventListener('visibilitychange', run);
    return () => {
      alive = false;
      clearInterval(iv);
      document.removeEventListener('visibilitychange', run);
    };
  }, [refresh, accept]);

  /**
   * While the panel is open, run the clock every 30s.
   *
   * The poll above already does this, but it is the same 30s interval the
   * numbers arrive on — so a countdown reading "in 4h 36m" could sit unchanged
   * for most of a minute in front of someone watching it. Only while open,
   * because a re-render a second is not worth paying for a closed panel.
   */
  useEffect(() => {
    if (!open) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [open]);

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
  const gone = expired(usage.fiveHour, now);
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
            style={{ width: `${percent}%`, background: colorFor(percent) }}
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
