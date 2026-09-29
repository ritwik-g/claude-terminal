import React, { useEffect, useId, useRef, useState } from 'react';
import { useEscapeLayer } from '../hooks';
import { Icon, type IconName } from './Icons';
import { IconButton } from '../ui';
import '../styles/dialogs.css';

interface ModalProps {
  onClose: () => void;
  children: React.ReactNode;
  /** Extra classes for the card, after `modal-card`. */
  className?: string;
  style?: React.CSSProperties;
  /** Extra classes for the backdrop, after `modal-overlay`. */
  overlayClassName?: string;
  overlayStyle?: React.CSSProperties;
  /** Id of the element that names the dialog. */
  labelledBy?: string;
  /** Accessible name when no visible heading can be referenced. */
  title?: string;
  /** Element to focus on open; defaults to the first focusable in the card. */
  initialFocusRef?: React.RefObject<HTMLElement>;
  /**
   * A dialog opened from inside another dialog. Esc then closes only this one;
   * top-level dialogs leave Esc to App, which closes them all.
   */
  nested?: boolean;

  /*
   * Optional slots. With `heading`, the dialog renders the standard header
   * (icon, heading, description, close button), wraps `children` in the padded
   * body and names itself after the heading. Without it, `children` fill the
   * card as they always did.
   */
  /** Visible dialog heading. */
  heading?: React.ReactNode;
  /** One line under the heading explaining what the dialog does. */
  description?: React.ReactNode;
  /** Icon shown before the heading: an icon name or any node (e.g. VendorIcon). */
  icon?: IconName | React.ReactNode;
  /** Extra controls in the header, before the close button. */
  headerActions?: React.ReactNode;
  /** Footer actions, right-aligned with the primary action last. */
  footer?: React.ReactNode;
  /** Footer content on the left, e.g. a hint or the selected path. */
  footerStart?: React.ReactNode;
  /** Card width: sm 480 (simple), md 640 (forms), lg 880 (dashboards). */
  size?: 'sm' | 'md' | 'lg';
  /** Extra classes for the body wrapper (only with `heading`). */
  bodyClassName?: string;
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

// Open dialogs, innermost last. Only the innermost one traps Tab.
const openCards: HTMLElement[] = [];

function focusableIn(card: HTMLElement): HTMLElement[] {
  return Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0
  );
}

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

export const Modal: React.FC<ModalProps> = ({
  onClose,
  children,
  className,
  style,
  overlayClassName,
  overlayStyle,
  labelledBy,
  title,
  initialFocusRef,
  nested = false,
  heading,
  description,
  icon,
  headerActions,
  footer,
  footerStart,
  size,
  bodyClassName,
}) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const descriptionId = useId();
  // Read during the first render, before any autoFocus child inside the card takes focus.
  const [returnFocusTo] = useState(() => document.activeElement as HTMLElement | null);
  // A drag that starts inside the card and ends on the backdrop must not close it.
  const pressedBackdrop = useRef(false);

  useEscapeLayer(nested, onClose);

  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    openCards.push(card);

    // Children may already have focused something (autoFocus, their own effects).
    if (initialFocusRef?.current) {
      initialFocusRef.current.focus();
    } else if (!card.contains(document.activeElement)) {
      // With the standard header, start in the body rather than on the close button.
      const body = card.querySelector<HTMLElement>(':scope > .dlg-body');
      (
        (body && (body.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') || focusableIn(body)[0])) ||
        focusableIn(card)[0] ||
        card
      ).focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || openCards[openCards.length - 1] !== card) return;
      const items = focusableIn(card);
      if (items.length === 0) {
        e.preventDefault();
        card.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!card.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (active === first || active === card)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const idx = openCards.indexOf(card);
      if (idx !== -1) openCards.splice(idx, 1);
      if (returnFocusTo && returnFocusTo.isConnected && returnFocusTo !== document.body) {
        returnFocusTo.focus();
      }
    };
    // Focus setup and restore run once per open dialog.
  }, []);

  const hasHeader = heading != null;
  const iconNode =
    icon == null ? null : typeof icon === 'string' ? <Icon name={icon as IconName} size={16} /> : icon;

  return (
    <div
      className={cx('modal-overlay', nested && 'is-nested', overlayClassName)}
      style={overlayStyle}
      onMouseDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressedBackdrop.current) onClose();
        pressedBackdrop.current = false;
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? (hasHeader ? headingId : undefined)}
        aria-describedby={hasHeader && description ? descriptionId : undefined}
        aria-label={labelledBy || hasHeader ? undefined : title}
        tabIndex={-1}
        className={cx('modal-card', size && `modal-${size}`, hasHeader && 'has-slots', className)}
        style={style}
        onClick={(e) => e.stopPropagation()}
      >
        {hasHeader ? (
          <>
            <header className="dlg-header">
              {iconNode && <span className="dlg-header-icon">{iconNode}</span>}
              <div className="dlg-header-text">
                <h2 id={headingId} className="dlg-title">
                  {heading}
                </h2>
                {description && (
                  <p id={descriptionId} className="dlg-desc">
                    {description}
                  </p>
                )}
              </div>
              <div className="dlg-header-actions">
                {headerActions}
                <IconButton icon="x" label="Close" title="Close (Esc)" className="dlg-close" onClick={onClose} />
              </div>
            </header>
            <div className={cx('dlg-body', bodyClassName)}>{children}</div>
            {(footer || footerStart) && (
              <footer className="dlg-footer">
                <div className="dlg-footer-start">{footerStart}</div>
                <div className="dlg-footer-actions">{footer}</div>
              </footer>
            )}
          </>
        ) : (
          children
        )}
      </div>
    </div>
  );
};
