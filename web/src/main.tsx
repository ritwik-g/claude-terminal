import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { App } from './App';

/**
 * Inside the Electron shell the title bar is `hiddenInset`, so the macOS
 * traffic-light buttons float over our own topbar — they overlapped the brand
 * text — and there is no system title bar left to drag the window by. Both are
 * CSS problems; this just tells the stylesheet which shell it is in.
 */
if (navigator.userAgent.includes('Electron')) {
  document.documentElement.classList.add('is-electron');
  if (navigator.userAgent.includes('Mac OS X')) {
    document.documentElement.classList.add('is-electron-mac');
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
