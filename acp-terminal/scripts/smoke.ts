import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import WebSocket from 'ws';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_PATH = path.resolve(__dirname, '../server/cli.ts');
const TSX_BIN = path.resolve(__dirname, '../node_modules/.bin/tsx');

async function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpGet(url: string, token?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token) headers['x-acp-token'] = token;

    http.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    }).on('error', reject);
  });
}

async function runSmokeTest() {
  console.log('💨 [Smoke Test] Launching ACP Terminal Server...');

  // Isolate smoke test storage from the user's real ~/.acp-terminal directory
  const testAppDir = path.join(os.tmpdir(), `acp-terminal-smoke-app-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  console.log(`📁 Using isolated test storage: ${testAppDir}\n`);

  // Verify that smoke test does not touch the user's real ~/.acp-terminal directory
  const realUserSessionsDir = path.join(os.homedir(), '.acp-terminal', 'sessions');
  const initialUserFiles = fs.existsSync(realUserSessionsDir) ? fs.readdirSync(realUserSessionsDir) : [];

  const serverProcess = spawn(TSX_BIN, [CLI_PATH], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: '7891',
      ACP_APP_DIR: testAppDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let token = '';

  serverProcess.stdout.on('data', (d) => {
    const text = d.toString();
    const m = text.match(/Token:\s+([a-f0-9]+)/);
    if (m) token = m[1];
  });

  serverProcess.stderr.on('data', (d) => {
    console.error(`[Server stderr] ${d.toString()}`);
  });

  try {
    // Wait for server to start
    console.log('   Waiting for server listening on 127.0.0.1:7891...');
    let started = false;
    for (let i = 0; i < 20; i++) {
      await wait(300);
      try {
        const res = await httpGet('http://127.0.0.1:7891/api/agents', token);
        if (res.status === 200) {
          started = true;
          break;
        }
      } catch {
        // retry
      }
    }

    if (!started) {
      throw new Error('Server failed to respond within timeout');
    }
    console.log('   ✅ Server listening and responding to HTTP requests');

    // Test /api/agents
    console.log('   Testing GET /api/agents...');
    const agentsRes = await httpGet('http://127.0.0.1:7891/api/agents', token);
    const parsedAgents = JSON.parse(agentsRes.body);
    console.log(`   Found ${parsedAgents.agents.length} agents: ${parsedAgents.agents.map((a: any) => a.id).join(', ')}`);
    if (!parsedAgents.agents || parsedAgents.agents.length === 0) {
      throw new Error('No agents returned from /api/agents');
    }

    // Test /api/sessions
    console.log('   Testing GET /api/sessions...');
    const sessionsRes = await httpGet('http://127.0.0.1:7891/api/sessions', token);
    const parsedSessions = JSON.parse(sessionsRes.body);
    console.log(`   Found ${parsedSessions.sessions.length} sessions (clean isolated store)`);

    // Test WebSocket connection
    console.log('   Testing WebSocket connection to ws://127.0.0.1:7891/ws...');
    const ws = new WebSocket(`ws://127.0.0.1:7891/ws?token=${token}`);

    const wsOpened = await new Promise<boolean>((resolve) => {
      ws.on('open', () => resolve(true));
      ws.on('error', () => resolve(false));
      setTimeout(() => resolve(false), 3000);
    });

    if (!wsOpened) {
      throw new Error('WebSocket connection failed');
    }
    console.log('   ✅ WebSocket connected successfully');

    const firstMsg = await new Promise<any>((resolve) => {
      ws.once('message', (d) => resolve(JSON.parse(d.toString())));
      setTimeout(() => resolve(null), 2000);
    });

    if (firstMsg?.type === 'initial') {
      console.log('   ✅ Received initial snapshot over WebSocket');
    }

    ws.close();

    // Browser-origin protections: foreign Origin rejected on the API and on WebSocket upgrades
    console.log('   Testing cross-origin rejection...');
    const crossPost = await fetch('http://127.0.0.1:7891/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
      body: JSON.stringify({ agentId: 'mock', cwd: os.tmpdir() }),
    });
    if (crossPost.status !== 403) throw new Error(`Cross-origin POST should be 403, got ${crossPost.status}`);
    const evilWs = new WebSocket('ws://127.0.0.1:7891/ws', { origin: 'http://evil.example' });
    const evilOpened = await new Promise<boolean>((resolve) => {
      evilWs.on('open', () => resolve(true));
      evilWs.on('error', () => resolve(false));
      setTimeout(() => resolve(false), 3000);
    });
    if (evilOpened) throw new Error('Cross-origin WebSocket upgrade must be rejected');
    console.log('   ✅ Cross-origin POST and WebSocket rejected');

    // A malformed Host header on an upgrade must not crash the server
    console.log('   Testing malformed Host on WebSocket upgrade...');
    await new Promise<void>((resolve) => {
      const sock = net.connect(7891, '127.0.0.1', () => {
        sock.write('GET /ws HTTP/1.1\r\nHost: [bad\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
      });
      sock.on('close', () => resolve());
      sock.on('error', () => resolve());
      setTimeout(() => { sock.destroy(); resolve(); }, 2000);
    });
    const alive = await httpGet('http://127.0.0.1:7891/api/agents', token);
    if (alive.status !== 200) throw new Error(`Server unhealthy after malformed Host upgrade (status ${alive.status})`);
    console.log('   ✅ Server survived malformed Host header');

    console.log('\n🎉 [Smoke Test Passed] Server, API routes, and WebSockets verified! 🚀');
  } finally {
    serverProcess.kill('SIGINT');

    // Verify no files were leaked to the user's real ~/.acp-terminal/sessions
    const finalUserFiles = fs.existsSync(realUserSessionsDir) ? fs.readdirSync(realUserSessionsDir) : [];
    if (finalUserFiles.length !== initialUserFiles.length) {
      console.error(`🚨 LEAK DETECTED: Files added to ${realUserSessionsDir}:`, finalUserFiles.filter(f => !initialUserFiles.includes(f)));
      throw new Error(`CRITICAL: Smoke test polluted production ~/.acp-terminal/sessions directory!`);
    }

    try {
      fs.rmSync(testAppDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

runSmokeTest().catch((err) => {
  console.error('\n❌ Smoke test failed:', err);
  process.exit(1);
});
