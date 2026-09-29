import React, { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icons';
import { IconButton, Kbd } from '../ui';
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
  /** Extra classes for the trigger button. */
  triggerClassName?: string;
  triggerIcon?: IconName;
  triggerVariant?: 'ghost' | 'secondary';
  size?: 'sm' | 'md';
  align?: 'left' | 'right';
}> = ({ items, label, triggerClassName, triggerIcon = 'more', triggerVariant = 'ghost', size = 'md', align = 'right' }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEscapeLayer(open, () => {
    setOpen(false);
    triggerRef.current?.focus();
  });

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
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
    if (buttons.length === 0) return;
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = (idx + 1) % buttons.length;
    else if (e.key === 'ArrowUp') next = (idx - 1 + buttons.length) % buttons.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = buttons.length - 1;
    else if (e.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (next === -1) return;
    e.preventDefault();
    buttons[next]?.focus();
  };

  return (
    <div className="menu-root" ref={rootRef}>
      <IconButton
        ref={triggerRef}
        icon={triggerIcon}
        label={label}
        variant={triggerVariant}
        size={size}
        active={open}
        className={triggerClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      />
      {open && (
        <div className={`menu-popover is-${align}`} role="menu" aria-label={label} ref={listRef} onKeyDown={onListKeyDown}>
          {items.map((item, i) =>
            item === 'divider' ? (
              <div key={`d${i}`} className="menu-divider" role="separator" />
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={`menu-item${item.danger ? ' is-danger' : ''}`}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                <span className="menu-item-icon">{item.icon && <Icon name={item.icon} size={15} />}</span>
                <span className="menu-item-label">{item.label}</span>
                {item.hint && <Kbd>{item.hint}</Kbd>}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
};
