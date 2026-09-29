import React, { useEffect, useRef, useState } from 'react';
import { Icon, IconButton, type IconName } from '../ui';
import { useTheme, type ThemePreference } from '../design/theme';
import { useEscapeLayer } from '../hooks';

const OPTIONS: Array<{ value: ThemePreference; label: string; icon: IconName }> = [
  { value: 'system', label: 'System', icon: 'monitor' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'light', label: 'Light', icon: 'sun' },
];

/** Theme picker for the sidebar footer: System, Dark or Light. Opens upwards. */
export const ThemeMenu: React.FC = () => {
  const { preference, resolved, setPreference } = useTheme();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEscapeLayer(open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    listRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button') || []);
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? (idx + 1) % buttons.length : (idx - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  const current = preference === 'system' ? 'monitor' : resolved === 'light' ? 'sun' : 'moon';

  return (
    <div className="theme-menu" ref={rootRef}>
      <IconButton
        icon={current}
        label={`Theme: ${OPTIONS.find((o) => o.value === preference)?.label}`}
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="theme-menu"
        active={open}
        onClick={() => setOpen(!open)}
      />
      {open && (
        <div className="theme-menu-pop" role="menu" aria-label="Theme" ref={listRef} onKeyDown={onListKeyDown}>
          <div className="theme-menu-title">Theme</div>
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitemradio"
              aria-checked={preference === o.value}
              className="theme-menu-item"
              onClick={() => {
                setPreference(o.value);
                setOpen(false);
              }}
            >
              <Icon name={o.icon} size={14} />
              <span className="theme-menu-label">{o.label}</span>
              {preference === o.value && <Icon name="check" size={13} className="theme-menu-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
