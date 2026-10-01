import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import type { AddressInfo, Socket } from 'node:net';
import { apiRouter } from './api.js';
import { setupWebSockets } from './ws.js';
import { sessionManager } from './acp/session-mgr.js';
import { getOrCreateToken, initStorage } from './paths.js';
import { loadStoredCredentials } from './subscriptions.js';
import { checkAccess, headerToken } from './security.js';
import { webManifest } from './manifest.js';
import { resolveStartupNetwork } from './network.js';
import { lanAccess, readStoredLanEnabled, type LanStatus } from './lan.js';

export interface StartServerOptions {
  /** Built web client to serve; nothing is served outside /api when absent or missing. */
  staticDir?: string;
  /** Defaults to PORT, then 7890. 0 picks a free port. */
  port?: number;
}

export interface ServerHandle {
  /** Loopback address of the server, without the token. */
  url: string;
  /** `url` with the access token, for opening the UI in a browser or window. */
  clientUrl: string;
  port: number;
  token: string;
  /** LAN state right after startup, including interfaces that failed to bind. */
  lan: LanStatus;
  /** Sessions whose agent process is running (or starting) right now. */
  runningAgentCount(): number;
  /** Stops every listener and every agent and terminal this server started. */
  close(): Promise<void>;
}

/** Where this machine reaches a listener bound to `host`. */
function urlHost(host: string): string {
  if (host === '0.0.0.0' || host === '::' || host === 'localhost') return '127.0.0.1';
  return host.includes(':') ? `[${host}]` : host;
}

/**
 * Starts the HTTP + WebSocket server. Used by `server/cli.ts` (npm start / npm run
 * dev) and by the CodePit desktop app, which hosts the server in its main process.
 */
export async function startServer(opts: StartServerOptions = {}): Promise<ServerHandle> {
  initStorage();
  loadStoredCredentials();

  const app = express();

  // JSON only: the web client never sends form bodies, and a urlencoded parser would let a
  // cross-site HTML form reach the API as a "simple" request without a CORS preflight.
  app.use(express.json({ limit: '50mb' }));

  const token = getOrCreateToken();

  app.use((req, res, next) => {
    // Allow static assets and favicon without token
    if (!req.path.startsWith('/api')) {
      return next();
    }
    const reqToken = headerToken(req.headers) ?? (typeof req.query.token === 'string' ? req.query.token : undefined);
    const decision = checkAccess(req, reqToken, token);
    if (decision.ok) {
      return next();
    }
    res.status(decision.status).json({ error: decision.error });
  });

  app.use('/api', apiRouter);

  // Asked for with the page's own token, which goes back in the start link only when it is valid
  app.get('/manifest.webmanifest', (req, res) => {
    const asked = typeof req.query.token === 'string' ? req.query.token : undefined;
    res
      .type('application/manifest+json')
      .set('Cache-Control', 'no-store')
      .send(JSON.stringify(webManifest(asked && asked === token ? asked : undefined)));
  });

  const staticDir = opts.staticDir;
  if (staticDir && fs.existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  const attachWebSockets = setupWebSockets();
  const server = http.createServer(app);
  attachWebSockets(server);
  // Tracked so close() does not wait on idle keep-alive and WebSocket connections
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  sessionManager.init();

  const network = resolveStartupNetwork(readStoredLanEnabled());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? Number(process.env.PORT || 7890), network.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  const lan = await lanAccess.start({
    handler: app,
    attach: attachWebSockets,
    port,
    host: network.host,
    enabled: network.lanEnabled,
    lockedReason: network.lockedReason,
  });

  const url = `http://${urlHost(network.host)}:${port}`;
  let closing: Promise<void> | null = null;

  return {
    url,
    clientUrl: `${url}/?token=${token}`,
    port,
    token,
    lan,
    runningAgentCount: () => sessionManager.listSessions().filter((s) => s.isAgentRunning).length,
    close: () =>
      (closing ??= (async () => {
        sessionManager.shutdown();
        await lanAccess.close();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          for (const socket of sockets) socket.destroy();
        });
      })()),
  };
}
