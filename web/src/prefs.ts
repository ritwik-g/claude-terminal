import { useCallback, useEffect, useState } from 'react';

/**
 * The handful of numbers that are genuinely yours rather than the app's.
 *
 * Kept in localStorage rather than in state.json because none of them describe
 * a session: they describe when YOU want to be interrupted and when your day
 * starts. state.json is the server's record of per-session facts and is shared
 * by every client that talks to it; these are per-person, and the settings
 * panel is the only thing that reads them.
 */
export interface Prefs {
  /** Master switch for the usage alerts. Off means no banner and no popup. */
  alertsEnabled: boolean;
  /**
   * Percent of a usage window at which the alert fires. The default is 80
   * because that is roughly where a long session still has room to be
   * compacted into something that fits the rest of the window — at 95 the
   * decision has already been made for you.
   */
  usageThresholdPct: number;
  /** Minutes of warning before a window rolls over. */
  resetLeadMin: number;
  /**
   * Context size, in thousands of tokens, above which a session is offered as
   * worth compacting.
   *
   * Absolute rather than a percentage of the model's limit, because the
   * transcript does not record which limit applies — a 1M-context run and a
   * 200k one both write `claude-opus-5` — and because what you are managing
   * here is cost, which tracks the size of the context you re-send every turn,
   * not how close it is to overflowing.
   *
   * The default sits just past a full standard context window: at 250k the
   * session is carrying more conversation than a 200k model could hold at all,
   * which is a fair definition of "big enough to be worth spending a turn on".
   * Measured against a real 100-session tree it marks about half of them and
   * 4 in 10 of the last week's. That ratio is the point — a threshold two
   * thirds of every row clears is a decoration, not a signal — so tune it down
   * if your sessions run smaller than this one's author's do.
   */
  compactAtKTokens: number;
  /**
   * Warn before a running session's prompt cache expires. Separate from the
   * usage alerts: those are about the account's windows, this is about one
   * session's next turn costing a full rewrite of its context.
   */
  cacheAlertsEnabled: boolean;
  /** Minutes of cache left at which the warning fires. */
  cacheLeadMin: number;
  /**
   * Context size, in thousands of tokens, below which an expiring cache is not
   * worth mentioning. Claude Code's own system prompt is cached separately and
   * lasts longer, so a small session's rebuild costs next to nothing; this
   * keeps the warning for the ones where it does.
   */
  cacheAlertAtKTokens: number;
  /**
   * When a "tomorrow" or "next week" snooze wakes, as minutes past local
   * midnight. Weekends are skipped — see wakeAt() in util.ts.
   */
  wakeMinutes: number;
}

export const DEFAULT_PREFS: Prefs = {
  alertsEnabled: true,
  usageThresholdPct: 80,
  resetLeadMin: 30,
  compactAtKTokens: 250,
  cacheAlertsEnabled: true,
  cacheLeadMin: 20,
  cacheAlertAtKTokens: 100,
  wakeMinutes: 9 * 60,
};

const KEY = 'ct.prefs';

const clamp = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;

/**
 * Every field is range-checked on the way in, not just on the way out of the
 * settings panel. The file is hand-editable and survives upgrades, so a value
 * that was valid under an older build — or one someone typed into devtools —
 * must not be able to put the alerts into a state where they fire constantly
 * or never.
 */
function sanitize(raw: any): Prefs {
  if (!raw || typeof raw !== 'object') return DEFAULT_PREFS;
  return {
    alertsEnabled: raw.alertsEnabled !== false,
    usageThresholdPct: clamp(raw.usageThresholdPct, 10, 99, DEFAULT_PREFS.usageThresholdPct),
    resetLeadMin: clamp(raw.resetLeadMin, 1, 240, DEFAULT_PREFS.resetLeadMin),
    compactAtKTokens: clamp(raw.compactAtKTokens, 10, 900, DEFAULT_PREFS.compactAtKTokens),
    cacheAlertsEnabled: raw.cacheAlertsEnabled !== false,
    cacheLeadMin: clamp(raw.cacheLeadMin, 1, 55, DEFAULT_PREFS.cacheLeadMin),
    cacheAlertAtKTokens: clamp(raw.cacheAlertAtKTokens, 0, 900, DEFAULT_PREFS.cacheAlertAtKTokens),
    wakeMinutes: clamp(raw.wakeMinutes, 0, 23 * 60 + 59, DEFAULT_PREFS.wakeMinutes),
  };
}

export function loadPrefs(): Prefs {
  try {
    return sanitize(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return DEFAULT_PREFS;
  }
}

/** Prefs plus a setter that persists. Owned by App and passed down. */
export function usePrefs(): [Prefs, (patch: Partial<Prefs>) => void] {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
  }, [prefs]);

  const patch = useCallback((p: Partial<Prefs>) => {
    setPrefs((prev) => sanitize({ ...prev, ...p }));
  }, []);

  return [prefs, patch];
}
