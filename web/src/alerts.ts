import { useEffect, useRef, useState } from 'react';
import type { Session } from '../../server/types';
import type { UsageSnapshot, UsageWindow } from '../../server/usage';
import type { Prefs } from './prefs';
import {
  breakCandidates, breakDue, cacheExpiresAt, cacheExpiring, clockTime, formatLeft, formatTokens, resetsIn,
  windowExpired, type BreakKind, type BreakSlot,
} from './util';

export type AlertKind = 'threshold' | 'reset-soon';
export type WindowKey = 'fiveHour' | 'weekly';

export interface UsageAlert {
  /**
   * Identity, and the reason an alert fires once rather than every 30 seconds.
   *
   * It carries the window's own reset timestamp, which is what makes the key
   * self-expiring: when the window rolls over it gets a new reset time, so the
   * same condition in the NEXT window is a different key and is allowed to fire
   * again. Nothing has to be cleaned up on a schedule.
   */
  key: string;
  kind: AlertKind;
  window: WindowKey;
  label: string;
  headline: string;
  detail: string;
  percent: number;
}

const WINDOW_LABEL: Record<WindowKey, string> = {
  fiveHour: '5-hour window',
  weekly: 'This week',
};

/**
 * Every alert the current numbers justify, most urgent first.
 *
 * Pure: it decides what is TRUE right now, and says nothing about what has
 * already been shown. Suppressing repeats is the hook's job below, which keeps
 * the rule — "80% is worth knowing about" — separate from the bookkeeping of
 * whether you have been told.
 */
export function alertsFor(usage: UsageSnapshot | null, prefs: Prefs, now: number): UsageAlert[] {
  if (!usage || !prefs.alertsEnabled) return [];
  const out: UsageAlert[] = [];
  const leadMs = prefs.resetLeadMin * 60_000;

  const consider = (key: WindowKey, w: UsageWindow | null) => {
    if (!w) return;
    const label = WINDOW_LABEL[key];
    const stamp = w.resetsAt ?? 0;

    // A reading whose own window has already rolled over describes a window
    // that no longer exists, so its percentage cannot justify anything.
    if (!windowExpired(w, now) && w.percent >= prefs.usageThresholdPct) {
      out.push({
        key: `${key}:pct:${stamp}`,
        kind: 'threshold',
        window: key,
        label,
        percent: w.percent,
        headline: `${label} is ${w.percent}% used`,
        detail: w.resetsAt
          ? `Resets ${clockTime(w.resetsAt, now)} — in ${resetsIn(w.resetsAt, now)}.`
          : 'No reset time reported.',
      });
    }

    // Independent of the percentage and of staleness: a reset time is a fixed
    // timestamp, so this stays correct however old the reading behind it is.
    if (w.resetsAt !== null && w.resetsAt > now && w.resetsAt - now <= leadMs) {
      out.push({
        key: `${key}:reset:${stamp}`,
        kind: 'reset-soon',
        window: key,
        label,
        percent: w.percent,
        headline: `${label} resets in ${resetsIn(w.resetsAt, now)}`,
        detail: `At ${clockTime(w.resetsAt, now)} it starts again from zero — ${w.percent}% is in use now.`,
      });
    }
  };

  consider('fiveHour', usage.fiveHour);
  consider('weekly', usage.weekly);

  // The 5-hour window is the one that stops work today, so it leads. Within a
  // window, running out matters more than a reset you are about to be given.
  const rank = (a: UsageAlert) =>
    (a.window === 'fiveHour' ? 0 : 2) + (a.kind === 'threshold' ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b));
}

export type NotifyPermission = 'unsupported' | 'default' | 'granted' | 'denied';

export function notifyPermission(): NotifyPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission as NotifyPermission;
}

/** Ask for desktop notifications. Must be called from a click — browsers require it. */
export async function askNotifyPermission(): Promise<NotifyPermission> {
  if (notifyPermission() === 'unsupported') return 'unsupported';
  try {
    return (await Notification.requestPermission()) as NotifyPermission;
  } catch {
    return notifyPermission();
  }
}

function post(a: UsageAlert): void {
  if (notifyPermission() !== 'granted') return;
  try {
    // `tag` is the browser's own de-duplication: if one of these is still on
    // screen when a second fires for the same window, it replaces it rather
    // than stacking a second card on top.
    new Notification(a.headline, { body: a.detail, tag: `ct-usage-${a.window}` });
  } catch {
    // Some platforms refuse to construct one even with permission granted.
    // The in-app banner has already said the same thing.
  }
}

/**
 * The alerts you have not dismissed, with the desktop popups raised as a side
 * effect.
 *
 * The two halves deliberately behave differently. A popup fires ONCE per
 * condition, because a notification is an interruption and repeating it is how
 * people end up turning notifications off. The banner stays until you dismiss
 * it, because it is not an interruption — it is a fact about the window you are
 * still working in, and hiding it after a few seconds would mean the one glance
 * that mattered was the one you missed.
 */
export function useUsageAlerts(
  usage: UsageSnapshot | null,
  prefs: Prefs,
  now: number,
): { active: UsageAlert[]; dismiss: (key: string) => void } {
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  // Popup bookkeeping, not render state: changing it must not re-render, or the
  // effect that writes it would schedule itself again.
  const notified = useRef<Set<string>>(new Set());

  const all = alertsFor(usage, prefs, now);
  const active = all.filter((a) => !dismissed.has(a.key));

  // Serialised so the effect runs on a CHANGE of which alerts hold, not on
  // every tick of the clock that produced an equal array.
  const signature = all.map((a) => a.key).join('|');

  useEffect(() => {
    if (!prefs.alertsEnabled) return;
    for (const a of all) {
      if (notified.current.has(a.key)) continue;
      notified.current.add(a.key);
      // Already looking at it. The same rule the completion notifications
      // follow: a popup for something on screen is the fastest way to make
      // someone turn popups off.
      if (document.hasFocus()) continue;
      post(a);
    }
    // `all` is rebuilt every render; `signature` is what actually changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, prefs.alertsEnabled]);

  // Turning alerts off and on again is a deliberate "tell me again", and an
  // emptied dismissal set is what makes that mean something.
  useEffect(() => {
    if (prefs.alertsEnabled) return;
    setDismissed(new Set());
    notified.current = new Set();
  }, [prefs.alertsEnabled]);

  return {
    active,
    dismiss: (key: string) => setDismissed((prev) => new Set(prev).add(key)),
  };
}

/**
 * Identity of one cache's warning. The last API call is in it, so a session
 * that takes another turn has a new cache with a new key: dismissing the
 * warning silences THIS expiry, not every one after it.
 */
export function cacheKey(s: Session): string {
  return `${s.id}:${s.lastApiAt}`;
}

/**
 * Running sessions whose prompt cache is about to expire, minus the ones you
 * have dismissed, with a desktop notification raised once per cache when the
 * window is not focused — the same popup rules as the usage alerts above.
 */
export function useCacheAlerts(
  sessions: Session[],
  prefs: Prefs,
  now: number,
): { active: Session[]; dismiss: (keys: string[]) => void } {
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const notified = useRef<Set<string>>(new Set());

  const all = prefs.cacheAlertsEnabled
    ? cacheExpiring(sessions, { leadMs: prefs.cacheLeadMin * 60_000, minTokens: prefs.cacheAlertAtKTokens * 1000 }, now)
    : [];
  const active = all.filter((s) => !dismissed.has(cacheKey(s)));
  const signature = all.map(cacheKey).join('|');

  useEffect(() => {
    for (const s of all) {
      const key = cacheKey(s);
      if (notified.current.has(key)) continue;
      notified.current.add(key);
      if (document.hasFocus()) continue;
      if (notifyPermission() !== 'granted') continue;
      const at = cacheExpiresAt(s) ?? now;
      try {
        new Notification(s.title, {
          body: `Prompt cache expires in ${formatLeft(at - now)} (${clockTime(at, now)}). Keep it warm or compact it before then.`,
          tag: `ct-cache-${s.id}`,
        });
      } catch {
        // The bar says the same thing.
      }
    }
    // `all` is rebuilt every render; `signature` is what actually changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return {
    active,
    dismiss: (keys: string[]) => setDismissed((prev) => {
      const next = new Set(prev);
      for (const k of keys) next.add(k);
      return next;
    }),
  };
}

export interface BreakReminder extends BreakSlot {
  /** Running sessions with a warm cache worth dealing with — see breakCandidates. */
  sessions: Session[];
}

/**
 * Where a break reminder's dismissal and popup are remembered. In
 * localStorage, not in memory, so reopening the app at 4:05 does not raise the
 * 4:00 reminder a second time. One key each is enough: only today's latest
 * reminder can be due.
 */
const BREAK_DISMISSED = 'ct.break.dismissed';
const BREAK_NOTIFIED = 'ct.break.notified';

const readKey = (k: string): string | null => {
  try { return localStorage.getItem(k); } catch { return null; }
};
const writeKey = (k: string, v: string): void => {
  try { localStorage.setItem(k, v); } catch { /* private mode: it may repeat */ }
};

const BREAK_TEXT: Record<BreakKind, (n: number) => string> = {
  lunch: (n) => `${n === 1 ? 'A session still has' : `${n} sessions still have`} a warm cache. Keep ${n === 1 ? 'it' : 'them'} warm over lunch, or compact now while that is cheap.`,
  'day-end': (n) => `${n === 1 ? 'A session still has' : `${n} sessions still have`} a warm cache. Compact now while that is cheap — after an hour away, the next turn rewrites the whole context.`,
};

/** The headline, which knows a Friday afternoon from any other. */
export function breakHeadline(kind: BreakKind, at: number): string {
  if (kind === 'lunch') return 'Stepping away for lunch?';
  return new Date(at).getDay() === 5 ? 'Wrapping up for the weekend?' : 'Wrapping up for the day?';
}

export function breakDetail(kind: BreakKind, count: number): string {
  return BREAK_TEXT[kind](count);
}

/**
 * The break reminder due now, if it has anything to say and you have not
 * dismissed it, with a desktop notification once per reminder when the window
 * is not focused.
 *
 * It says nothing when no running session has a warm cache worth the trouble:
 * a reminder to compact nothing is how reminders get turned off.
 */
export function useBreakReminder(
  sessions: Session[],
  prefs: Prefs,
  now: number,
): { reminder: BreakReminder | null; dismiss: () => void } {
  const [dismissed, setDismissed] = useState<string | null>(() => readKey(BREAK_DISMISSED));

  const slot = breakDue(now, { lunch: prefs.lunchReminder, 'day-end': prefs.dayEndReminder });
  const list = slot ? breakCandidates(sessions, slot.kind, prefs.cacheAlertAtKTokens * 1000, now) : [];
  const reminder = slot && list.length > 0 && dismissed !== slot.key ? { ...slot, sessions: list } : null;

  const key = reminder?.key ?? null;
  useEffect(() => {
    if (!reminder || readKey(BREAK_NOTIFIED) === reminder.key) return;
    writeKey(BREAK_NOTIFIED, reminder.key);
    if (document.hasFocus() || notifyPermission() !== 'granted') return;
    const big = reminder.sessions.map((s) => `${s.title} (${formatTokens(s.contextTokens)})`).join(', ');
    try {
      new Notification(breakHeadline(reminder.kind, reminder.at), {
        body: `${breakDetail(reminder.kind, reminder.sessions.length)} ${big}`,
        tag: 'ct-break',
      });
    } catch {
      // The bar says the same thing.
    }
    // Once per reminder; the list inside it changing is not a new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return {
    reminder,
    dismiss: () => {
      if (!slot) return;
      writeKey(BREAK_DISMISSED, slot.key);
      setDismissed(slot.key);
    },
  };
}
