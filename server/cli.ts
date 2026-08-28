/**
 * Standalone (headless) entry point: runs the server without Electron, for
 * `npm start`, `bin/claude-terminal`, and any Linux box where you would rather
 * use your own browser than ship a 100MB app bundle.
 *
 * The desktop app does NOT go through here — it hosts startServer() in its own
 * main process so that quitting the app genuinely stops the server.
 */
import { startServer, DEFAULT_PORT, DEFAULT_HOST } from './index.js';

const handle = await startServer().catch((err: NodeJS.ErrnoException) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(
      `[claude-terminal] port ${DEFAULT_PORT} is already in use — is it already running?\n` +
      `  check:  bin/claude-terminal status`,
    );
  } else {
    console.error('[claude-terminal] failed to start:', err);
  }
  process.exit(1);
});

// The bare URL loads the page but every API call from it is unauthorized, so
// print the one that carries the token — that is the link to actually open.
console.log(`claude-terminal server  ${handle.url}`);
console.log(`open in a browser       ${handle.clientUrl}`);

// Losing debounced tag edits because a terminal window closed is not acceptable,
// so every ordinary termination path flushes first.
let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  handle.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);

// A crash must not orphan every PTY, so log and keep serving rather than die.
process.on('uncaughtException', (err) => console.error('[claude-terminal] uncaught:', err));
process.on('unhandledRejection', (err) => console.error('[claude-terminal] unhandled rejection:', err));

void DEFAULT_HOST;
