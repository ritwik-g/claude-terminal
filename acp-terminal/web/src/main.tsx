import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { applyTheme, readThemePreference } from './design/theme';
import '@xterm/xterm/css/xterm.css';
import './design/tokens.css';
import './design/base.css';
import './styles/legacy-utils.css';
import './styles/shell.css';
import './styles/workspace.css';
import './styles/conversation.css';

// Apply the saved theme before the first paint so the page doesn't flash.
applyTheme(readThemePreference());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
