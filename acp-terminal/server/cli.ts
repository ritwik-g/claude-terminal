import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { apiRouter } from './api.js';
import { setupWebSockets } from './ws.js';
import { sessionManager } from './acp/session-mgr.js';
import { getOrCreateToken, initStorage } from './paths.js';
import { loadStoredCredentials } from './subscriptions.js';
import { checkAccess, isLoopbackBind } from './security.js';
import { getLocalNetworkIps, resolveBindHost } from './network.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// ACP_DIST_DIR lets parallel UI builds each serve their own bundle.
const DIST_DIR = process.env.ACP_DIST_DIR ? path.resolve(process.env.ACP_DIST_DIR) : path.resolve(__dirname, '../dist');

const app = express();
const server = http.createServer(app);

// JSON only: the web client never sends form bodies, and a urlencoded parser would let a
// cross-site HTML form reach the API as a "simple" request without a CORS preflight.
app.use(express.json({ limit: '50mb' }));

// Token authentication middleware
const token = getOrCreateToken();

app.use((req, res, next) => {
  // Allow static assets and favicon without token
  if (!req.path.startsWith('/api')) {
    return next();
  }
  const headerToken = req.headers['x-acp-token'];
  const reqToken = typeof headerToken === 'string' ? headerToken : typeof req.query.token === 'string' ? req.query.token : undefined;
  const decision = checkAccess(req, reqToken, token);
  if (decision.ok) {
    return next();
  }
  res.status(decision.status).json({ error: decision.error });
});

// Mount API routes
app.use('/api', apiRouter);

// Serve Web frontend if built
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
}

// Setup WebSocket server
setupWebSockets(server);

// Initialize storage and background engine
initStorage();
loadStoredCredentials();
sessionManager.init();

const PORT = Number(process.env.PORT || 7890);
const HOST = resolveBindHost();

server.listen(PORT, HOST, () => {
  // Network URLs are only reachable (and only worth printing with the token) when bound beyond loopback
  const ips = isLoopbackBind(HOST) ? [] : getLocalNetworkIps();
  console.log(`\n======================================================`);
  console.log(`  🚀 ACP Terminal Server running:`);
  console.log(`  👉 Local:   http://127.0.0.1:${PORT}`);
  for (const ip of ips) {
    console.log(`  👉 Network: http://${ip}:${PORT}?token=${token}`);
  }
  if (isLoopbackBind(HOST)) {
    console.log(`  🔒 LAN access disabled (HOST=${HOST}). Enable with: ACP_LAN=1 npm start`);
  }
  console.log(`  🔑 Token:   ${token}`);
  console.log(`======================================================\n`);
});

process.on('SIGINT', () => {
  console.log('\n[acp-terminal] Shutting down...');
  sessionManager.shutdown();
  process.exit(0);
});

process.on('SIGTERM', () => {
  sessionManager.shutdown();
  process.exit(0);
});
