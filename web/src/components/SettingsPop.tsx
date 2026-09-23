import { useEffect, useState } from 'react';
import { askNotifyPermission, notifyPermission, type NotifyPermission } from '../alerts';
import { hhmmToMinutes, minutesToHHMM } from '../util';
import type { Prefs } from '../prefs';

interface Props {
  prefs: Prefs;
  patch: (p: Partial<Prefs>) => void;
}

/** What the desktop-notification line says, given where permission stands. */
const PERMISSION_TEXT: Record<NotifyPermission, string> = {
  unsupported: 'This build cannot raise desktop notifications. The banner still appears.',
  default: 'Not asked yet — alerts appear as a banner in the app only.',
  granted: 'On. Alerts also arrive as a desktop notification when the app is not focused.',
  denied: 'Blocked. Turn notifications back on for this app in your system settings.',
};

/**
 * A number you type, with its unit spelled out beside it.
 *
 * Committed on blur rather than on every keystroke: these feed live thresholds,
 * and reacting to the '8' of '80' would fire an alert on the way to a setting
 * that would not have fired one.
 */
function NumField({
  label, value, min, max, suffix, onCommit, title,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix: string;
  onCommit: (n: number) => void;
  title?: string;
}): JSX.Element {
  const [draft, setDraft] = useState(String(value));
  // An edit somewhere else — a reset, another tab — has to show up here.
  useEffect(() => { setDraft(String(value)); }, [value]);

  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n)) { setDraft(String(value)); return; }
    onCommit(Math.min(max, Math.max(min, Math.round(n))));
  };

  return (
    <label className="set-row" title={title}>
      <span className="set-label">{label}</span>
      <input
        className="set-num"
        type="number"
        min={min}
        max={max}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
      <span className="set-suffix">{suffix}</span>
    </label>
  );
}

/**
 * The settings the app has: when to interrupt you about usage, and when your
 * day starts.
 *
 * Deliberately one small panel rather than a dialog. Everything in it is a
 * number you tune once after watching the alerts fire a couple of times, and a
 * full-screen settings surface for five fields would be furniture.
 */
export function SettingsPop({ prefs, patch }: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const [perm, setPerm] = useState<NotifyPermission>(() => notifyPermission());

  // Permission can be revoked from outside the app entirely, so re-read it
  // whenever the panel is opened rather than trusting what we saw last.
  useEffect(() => { if (open) setPerm(notifyPermission()); }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  return (
    <div className="set-group">
      <button
        className={`btn sm icon${open ? ' on' : ''}`}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((v) => !v)}
        title="Alerts, compaction and snooze settings"
        aria-label="Settings"
      >
        {'⚙'}
      </button>
      {open && (
        <>
          <div className="scrim" onClick={() => setOpen(false)} />
          <div className="set-pop" role="group" aria-label="Settings">
            <div className="set-head">Usage alerts</div>

            <label className="set-row set-check" title="Off means no banner and no desktop notification">
              <input
                type="checkbox"
                checked={prefs.alertsEnabled}
                onChange={(e) => patch({ alertsEnabled: e.target.checked })}
              />
              <span className="set-label">Warn me about the usage windows</span>
            </label>

            <NumField
              label="Warn at"
              value={prefs.usageThresholdPct}
              min={10}
              max={99}
              suffix="% of a window"
              title="Applies to the 5-hour window and the weekly one separately"
              onCommit={(n) => patch({ usageThresholdPct: n })}
            />
            <NumField
              label="And"
              value={prefs.resetLeadMin}
              min={1}
              max={240}
              suffix="min before a reset"
              title="A heads-up before a window rolls over and starts again from zero"
              onCommit={(n) => patch({ resetLeadMin: n })}
            />

            <div className={`set-note${perm === 'denied' ? ' warn' : ''}`}>
              {PERMISSION_TEXT[perm]}
              {perm === 'default' && (
                <button
                  className="btn sm"
                  style={{ marginLeft: 6 }}
                  onClick={() => { void askNotifyPermission().then(setPerm); }}
                >
                  Allow
                </button>
              )}
            </div>

            <div className="set-head">Prompt cache</div>
            <label className="set-row set-check" title="Off means no banner and no desktop notification">
              <input
                type="checkbox"
                checked={prefs.cacheAlertsEnabled}
                onChange={(e) => patch({ cacheAlertsEnabled: e.target.checked })}
              />
              <span className="set-label">Warn before a running session's cache expires</span>
            </label>
            <NumField
              label="Warn"
              value={prefs.cacheLeadMin}
              min={1}
              max={55}
              suffix="min before it expires"
              title="A session's prompt cache lasts an hour from its last API call"
              onCommit={(n) => patch({ cacheLeadMin: n })}
            />
            <NumField
              label="Only above"
              value={prefs.cacheAlertAtKTokens}
              min={0}
              max={900}
              suffix="k tokens of context"
              title="A small session's rebuild costs next to nothing, so it is not worth a warning"
              onCommit={(n) => patch({ cacheAlertAtKTokens: n })}
            />
            <div className="set-note">
              Once a cache expires, the next turn rewrites the whole context at about
              twice the input price. Before then, keeping it warm or compacting it is cheap.
              Sessions with keep-warm on are never warned about.
            </div>

            <div className="set-head">Compaction</div>
            <NumField
              label="Suggest compacting above"
              value={prefs.compactAtKTokens}
              min={10}
              max={900}
              suffix="k tokens"
              title="A session's context size, read from its last assistant turn"
              onCommit={(n) => patch({ compactAtKTokens: n })}
            />
            <div className="set-note">
              Big sessions are re-sent in full every turn, so they are what a usage
              window is mostly spent on. A running session above this size gets a
              context chip on its row.
            </div>

            <div className="set-head">Snooze</div>
            <label className="set-row" title="Weekends are skipped — a Friday 'tomorrow' wakes on Monday">
              <span className="set-label">“Tomorrow” and “next week” wake at</span>
              <input
                className="set-time"
                type="time"
                value={minutesToHHMM(prefs.wakeMinutes)}
                onChange={(e) => {
                  const m = hhmmToMinutes(e.target.value);
                  if (m !== null) patch({ wakeMinutes: m });
                }}
              />
            </label>
            <div className="set-note">
              Weekends are skipped, so a Friday evening snooze comes back on Monday
              morning rather than on a Saturday you were not going to look at.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
