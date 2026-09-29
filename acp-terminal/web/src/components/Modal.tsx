import React, { useEffect, useRef, useState } from 'react';
import { useEscapeLayer } from '../hooks';
import './modal.css';

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
}) => {
  const cardRef = useRef<HTMLDivElement>(null);
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
      (focusableIn(card)[0] || card).focus();
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

  return (
    <div
      className={overlayClassName ? `modal-overlay ${overlayClassName}` : 'modal-overlay'}
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
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : title}
        tabIndex={-1}
        className={className ? `modal-card ${className}` : 'modal-card'}
        style={style}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
};
