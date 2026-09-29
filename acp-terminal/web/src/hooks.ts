import { useEffect, useRef } from 'react';

// Stack of open overlay layers (dropdowns, nested dialogs, previews). Esc closes
// only the topmost one; App's own Esc handler, which closes whole modals, runs
// only when no layer is open.
const layers: Array<{ current: () => void }> = [];

function onKeyDownCapture(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || layers.length === 0) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  layers[layers.length - 1].current();
}

/** While `active`, Esc calls `onEscape` instead of reaching outer handlers. */
export function useEscapeLayer(active: boolean, onEscape: () => void): void {
  const handlerRef = useRef(onEscape);
  handlerRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const layer = { current: () => handlerRef.current() };
    if (layers.length === 0) window.addEventListener('keydown', onKeyDownCapture, true);
    layers.push(layer);
    return () => {
      const idx = layers.indexOf(layer);
      if (idx !== -1) layers.splice(idx, 1);
      if (layers.length === 0) window.removeEventListener('keydown', onKeyDownCapture, true);
    };
  }, [active]);
}
