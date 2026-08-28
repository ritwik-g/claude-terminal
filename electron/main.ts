import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, shell, Menu, type MenuItemConstructorOptions } from 'electron';

import { startServer, type ServerHandle } from '../server/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isDev = !app.isPackaged;

/**
 * The bundled main process lives at <root>/dist-electron/main.mjs and the
 * renderer at <root>/dist/ — and electron-builder preserves that relative
 * layout inside app.asar. So one path works for dev and packaged alike, which
 * removes the classic "works in dev, blank window when packaged" failure.
 */
const STATIC_DIR = path.join(__dirname, '..', 'dist');

let handle: ServerHandle | null = null;
let win: BrowserWindow | null = null;
let quitting = false;

/**
 * A second instance would fail on EADDRINUSE and, worse, could fight over the
 * state file. Hand focus to the running window instead.
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

async function createWindow(): Promise<void> {
  try {
    handle = await startServer({ staticDir: STATIC_DIR });
  } catch (err: any) {
    const inUse = err?.code === 'EADDRINUSE';
    dialog.showErrorBox(
      'Claude Terminal could not start',
      inUse
        ? `Port ${process.env.PORT ?? 7777} is already in use.\n\n` +
          `Another copy of Claude Terminal — or its command-line server — is ` +
          `probably already running. Quit that first, or set PORT to something else.`
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
    title: 'Claude Terminal',
    // Matches --bg so there is no white flash before the app paints.
    backgroundColor: '#0e1013',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
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

  // clientUrl carries the per-run token; the page strips it from the address bar.
  await win.loadURL(handle.clientUrl);
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{
          label: 'Claude Terminal',
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
          label: 'Reload Sessions',
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
  buildMenu();
  void createWindow();

  app.on('activate', () => {
    // macOS: clicking the dock icon with no windows open reopens one.
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

/**
 * Quitting kills every terminal this app started — that is the deliberate
 * consequence of holding the PTYs ourselves rather than putting tmux in the
 * middle. Say so before doing it, rather than silently destroying in-flight work.
 */
app.on('before-quit', (e) => {
  if (quitting) return;
  const live = handle?.liveTerminalCount() ?? 0;

  if (live > 0 && win && !win.isDestroyed()) {
    e.preventDefault();
    const { response } = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Cancel', `Quit and close ${live} terminal${live === 1 ? '' : 's'}`],
      defaultId: 0,
      cancelId: 0,
      message: `${live} terminal${live === 1 ? ' is' : 's are'} still running.`,
      detail:
        'Quitting closes them. Sessions running in your own terminals are not affected, ' +
        'and every session keeps its transcript — you can resume it later.',
    }) as unknown as { response: number };
    if (response !== 1) return;
    quitting = true;
    void shutdown();
    return;
  }

  e.preventDefault();
  quitting = true;
  void shutdown();
});

async function shutdown(): Promise<void> {
  try {
    await handle?.close();
  } catch (err) {
    console.error('[claude-terminal] shutdown error:', err);
  } finally {
    handle = null;
    app.exit(0);
  }
}

// On macOS an app normally stays alive with no windows; here the window IS the
// app, and leaving a headless server running after the user closed it would be
// a surprise.
app.on('window-all-closed', () => app.quit());
