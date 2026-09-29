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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.resolve(__dirname, '../dist');

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Token authentication middleware
const token = getOrCreateToken();

app.use((req, res, next) => {
  // Allow static assets and favicon without token
  if (!req.path.startsWith('/api')) {
    return next();
  }
  const reqToken = req.headers['x-acp-token'] || req.query.token;
  if (reqToken && reqToken === token) {
    return next();
  }
  // Allow local loopback dev requests
  const ip = (req.headers['x-test-remote-ip'] as string) || req.socket.remoteAddress;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized: missing or invalid x-acp-token' });
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

import { getLocalNetworkIps } from './network.js';

// Initialize storage and background engine
initStorage();
loadStoredCredentials();
sessionManager.init();

const PORT = Number(process.env.PORT || 7890);
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  const ips = getLocalNetworkIps();
  console.log(`\n======================================================`);
  console.log(`  🚀 ACP Terminal Server running:`);
  console.log(`  👉 Local:   http://127.0.0.1:${PORT}`);
  for (const ip of ips) {
    console.log(`  👉 Network: http://${ip}:${PORT}?token=${token}`);
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
