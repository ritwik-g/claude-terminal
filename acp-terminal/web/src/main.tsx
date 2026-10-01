import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { applyTheme, readThemePreference } from './design/theme';
import { getToken } from './api';
import '@xterm/xterm/css/xterm.css';
import './design/tokens.css';
import './design/base.css';
import './styles/shell.css';
import './styles/workspace.css';
import './styles/conversation.css';

// Apply the saved theme before the first paint so the page doesn't flash.
applyTheme(readThemePreference());

// The desktop app draws the macOS window buttons over the page (hidden title bar); the
// sidebar header makes room for them and doubles as the window's drag handle.
if (/\bElectron\//.test(navigator.userAgent) && /Mac/.test(navigator.platform)) {
  document.documentElement.dataset.shell = 'desktop-mac';
} else {
  // Installable on phones. The manifest's start link carries this page's access token,
  // since an app added to the home screen does not share the browser's storage
  const manifest = document.createElement('link');
  manifest.rel = 'manifest';
  const token = getToken();
  manifest.href = token ? `/manifest.webmanifest?token=${encodeURIComponent(token)}` : '/manifest.webmanifest';
  document.head.appendChild(manifest);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
