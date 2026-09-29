import React, { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icons';
import { useEscapeLayer } from '../hooks';

export interface MenuItem {
  label: string;
  icon?: IconName;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  hint?: string;
}

/** An overflow menu: a trigger button and a keyboard-navigable popover list. */
export const Menu: React.FC<{
  items: Array<MenuItem | 'divider'>;
  label: string;
  triggerClassName?: string;
  align?: 'left' | 'right';
}> = ({ items, label, triggerClassName = 'hbtn icon', align = 'right' }) => {
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
    listRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? (idx + 1) % buttons.length : (idx - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <div className="menu-root" ref={rootRef}>
      <button
        type="button"
        className={triggerClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen(!open)}
      >
        <Icon name="more" size={16} />
      </button>
      {open && (
        <div className={`menu-popover ${align}`} role="menu" ref={listRef} onKeyDown={onListKeyDown}>
          {items.map((item, i) =>
            item === 'divider' ? (
              <div key={`d${i}`} className="menu-divider" role="separator" />
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={`menu-item ${item.danger ? 'danger' : ''}`}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.icon && <Icon name={item.icon} size={14} />}
                <span>{item.label}</span>
                {item.hint && <span className="menu-hint">{item.hint}</span>}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
};
