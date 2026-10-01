import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, shell, Menu, type MenuItemConstructorOptions } from 'electron';

import { startServer, type ServerHandle } from '../server/server.js';
import { useBundledAgentRuntime } from '../server/agents/registry.js';
import { adoptLoginShellPath } from './shell-path.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isDev = !app.isPackaged;

/**
 * The bundled main process lives at <root>/dist-electron/main.mjs and the
 * renderer at <root>/dist/, and electron-builder keeps that layout inside
 * app.asar, so one path works for dev and packaged alike.
 */
const STATIC_DIR = path.join(__dirname, '..', 'dist');

/**
 * Files the agents run from. Nothing inside app.asar can be executed, so these are
 * unpacked next to it (see asarUnpack in electron-builder.yml). In dev the app path
 * is the project itself and the replace is a no-op.
 */
const UNPACKED_ROOT = app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked');
const AGENT_SCRIPTS_DIR = path.join(UNPACKED_ROOT, 'dist-electron', 'agents');

let handle: ServerHandle | null = null;
let starting: Promise<ServerHandle> | null = null;
let win: BrowserWindow | null = null;
let quitting = false;

/**
 * The app was called CT before CodePit, and Electron names its profile folder
 * after productName. Keep using the old folder when there is one (it holds the
 * theme choice), rather than starting a fresh profile. Must run before the
 * single-instance lock, which lives in that folder.
 */
const legacyUserData = path.join(app.getPath('appData'), 'CT');
if (!fs.existsSync(app.getPath('userData')) && fs.existsSync(legacyUserData)) {
  app.setPath('userData', legacyUserData);
}

/**
 * A second instance would fail on EADDRINUSE and could fight over the session
 * store. Hand focus to the running window instead.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
}

/** Starts the server once; reopening the window from the Dock reuses it. */
function ensureServer(): Promise<ServerHandle> {
  starting ??= (async () => {
    await adoptLoginShellPath();
    useBundledAgentRuntime({
      execPath: process.execPath,
      launcher: path.join(AGENT_SCRIPTS_DIR, 'agent-launcher.mjs'),
      modulesDir: path.join(UNPACKED_ROOT, 'node_modules'),
      scriptsDir: AGENT_SCRIPTS_DIR,
    });
    handle = await startServer({ staticDir: STATIC_DIR });
    return handle;
  })();
  return starting;
}

async function createWindow(): Promise<void> {
  let server: ServerHandle;
  try {
    server = await ensureServer();
  } catch (err: any) {
    const inUse = err?.code === 'EADDRINUSE';
    dialog.showErrorBox(
      'CodePit could not start',
      inUse
        ? `Port ${process.env.PORT ?? 7890} is already in use.\n\n` +
          `Another copy of CodePit, or the CodePit server (npm start), is probably ` +
          `already running. Quit that first, or set PORT to something else.`
        : `The server failed to start.\n\n${err?.message ?? err}`,
    );
    app.quit();
    return;
  }

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 520,
    title: 'CodePit',
    // Matches the dark theme's --bg so there is no white flash before the app paints.
    backgroundColor: '#0a0a0c',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Centred on the sidebar header row (--header-height 56px), left of the brand
    trafficLightPosition: { x: 18, y: 21 },
    show: false,
    webPreferences: {
      // The renderer is our own local page and talks to the server over HTTP,
      // so it needs no Node access at all.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win?.show());
  // The traffic lights are gone in full screen; the page drops the room it keeps for them
  const markFullScreen = () => {
    if (!win) return;
    void win.webContents
      .executeJavaScript(`document.documentElement.toggleAttribute('data-fullscreen', ${win.isFullScreen()})`)
      .catch(() => {});
  };
  win.on('enter-full-screen', markFullScreen);
  win.on('leave-full-screen', markFullScreen);
  win.webContents.on('did-finish-load', markFullScreen);
  // Closing the window quits the app, so route it through the quit confirmation
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    app.quit();
  });
  win.on('closed', () => { win = null; });

  // Anything that is not our own origin belongs in the user's real browser —
  // a PR link should not navigate the app away from itself.
  const external = (url: string) => {
    // Parse before comparing. A prefix test treats
    // 'http://127.0.0.1:7777@evil.com/x' as internal — the userinfo trick — and
    // lets the top-level window navigate away to attacker content.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return true;
    }
    if (handle && parsed.origin === new URL(handle.url).origin) return false;
    // Hand the OS only what a browser would take. A terminal prints whatever
    // it likes and shell.openExternal will dutifully dispatch any scheme to
    // whatever claims it, so anything that is not plain http(s) — 'about:blank'
    // from a blank popup, a file:// path, some app's custom scheme — is
    // swallowed here rather than turned into a system dialog or an app launch.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
    void shell.openExternal(url);
    return true;
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (external(url)) e.preventDefault();
  });
  // A same-origin URL that redirects off-origin never fires will-navigate.
  win.webContents.on('will-redirect', (e, url) => {
    if (external(url)) e.preventDefault();
  });

  // clientUrl carries the access token; the page keeps it in localStorage.
  await win.loadURL(server.clientUrl);
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{
          label: 'CodePit',
          submenu: [
            { role: 'about' as const },
            { type: 'separator' as const },
            { role: 'hide' as const },
            { role: 'hideOthers' as const },
            { type: 'separator' as const },
            { role: 'quit' as const },
          ],
        }]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => win?.webContents.reload(),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
        ...(isDev ? [{ role: 'toggleDevTools' as const }] : []),
      ],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  // Being signalled is a quit too: stop the agents rather than orphaning them.
  // No dialog, since a signal has no one to ask. Registered once ready because
  // Electron installs its own handlers during startup, which would replace these
  // and turn the signal into app.quit() and the quit confirmation.
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(sig, () => {
      if (quitting) return;
      quitting = true;
      void shutdown();
    });
  }

  app.setAboutPanelOptions({ applicationName: 'CodePit', credits: 'A pit wall for your coding agents' });
  buildMenu();
  void createWindow();

  app.on('activate', () => {
    // macOS: clicking the dock icon with no windows open reopens one.
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

/**
 * The agents are child processes of this app, so quitting stops them mid-turn.
 * Say so first rather than silently cutting off work in progress.
 */
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  const running = handle?.runningAgentCount() ?? 0;

  if (running > 0 && win && !win.isDestroyed()) {
    const response = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Cancel', `Quit and stop ${running} agent${running === 1 ? '' : 's'}`],
      defaultId: 0,
      cancelId: 0,
      message: `${running} agent${running === 1 ? ' is' : 's are'} still running.`,
      detail:
        'Quitting stops them, including any turn in progress. Every session keeps its ' +
        'conversation, and you can start its agent again when you reopen CodePit.',
    });
    if (response !== 1) return;
  }

  quitting = true;
  void shutdown();
});


async function shutdown(): Promise<void> {
  try {
    await handle?.close();
  } catch (err) {
    console.error('[codepit] shutdown error:', err);
  } finally {
    handle = null;
    app.exit(0);
  }
}

// On macOS an app normally stays alive with no windows; here the window IS the
// app, and leaving agents running headless after the user closed it would be
// a surprise.
app.on('window-all-closed', () => app.quit());
