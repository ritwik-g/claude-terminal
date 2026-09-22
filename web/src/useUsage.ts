import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type UsagePayload } from './api';
import type { UsageSnapshot } from '../../server/usage';

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

export interface UsageMeta {
  /** A probe is running somewhere — started by this tab or another one. */
  refreshing: boolean;
  /** False while Claude Code would throttle the refresh away, doing nothing. */
  refreshable: boolean;
  /** When that throttle lifts, epoch ms; null when it already has. */
  refreshableAt: number | null;
}

export interface UsageState {
  usage: UsageSnapshot | null;
  meta: UsageMeta;
  /** The cache vanished after we had numbers — keep showing them, dimmed. */
  lost: boolean;
  /** A probe started by THIS tab is in flight. */
  busy: boolean;
  refresh: (force: boolean, gap?: number) => Promise<void>;
}

/**
 * One poller for the account-wide usage windows, for the whole app.
 *
 * It lives up here rather than inside the pill because two things now watch
 * these numbers: the pill, which draws them, and the alerts, which decide
 * whether to interrupt you about them. Giving the alerts their own poller
 * would mean two clocks, two ideas of what is current, and — because a refresh
 * starts a real Claude Code session — two of those where one was wanted.
 */
export function useUsage(): UsageState {
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [meta, setMeta] = useState<UsageMeta>({ refreshing: false, refreshable: true, refreshableAt: null });
  const [lost, setLost] = useState(false);
  const [busy, setBusy] = useState(false);
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
      const present = await read();
      if (!alive || present === null) return;
      // Only while the window is on screen: a minimised app that keeps starting
      // Claude Code sessions is spending the user's quota to tell them about
      // their quota. The alerts accept that trade — a minimised app warns you
      // from the last numbers it has, and the reset times it warns about are
      // fixed timestamps that do not go stale at all.
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

  return { usage, meta, lost, busy, refresh };
}
