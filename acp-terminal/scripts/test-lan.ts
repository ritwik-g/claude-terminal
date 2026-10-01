import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';

// Isolate test storage from the user's real ~/.codepit directory BEFORE any imports
const testAppDir = path.join(os.tmpdir(), `codepit-lan-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
process.env.NODE_ENV = 'test';
process.env.CODEPIT_APP_DIR = testAppDir;
// The runtime switch is what's under test; startup overrides would pin it
delete process.env.CODEPIT_LAN;
delete process.env.ACP_LAN;
delete process.env.HOST;

const { startServer } = await import('../server/server.js');
const { resolveStartupNetwork, getLocalNetworkIps } = await import('../server/network.js');
const { getSettingsFile } = await import('../server/paths.js');
const { WebSocket } = await import('ws');

interface Reply {
  status: number;
  body: any;
}

/** http.request rather than fetch: fetch will not let a test set the Host header. */
function call(
  port: number,
  method: string,
  urlPath: string,
  opts: { host?: string; headers?: Record<string, string>; body?: unknown; address?: string } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: opts.address ?? '127.0.0.1',
        port,
        method,
        path: urlPath,
        agent: false,
        headers: {
          host: opts.host ?? `127.0.0.1:${port}`,
          ...(payload ? { 'content-type': 'application/json' } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let body: any = data;
          try {
            body = JSON.parse(data);
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function expect(cond: unknown, message: string): void {
  if (!cond) throw new Error(message);
}

async function runTests() {
  console.log('🧪 [Test Suite] LAN access switch\n');
  console.log(`📁 Using isolated test storage: ${testAppDir}\n`);

  // 1. Startup precedence: saved setting, then CODEPIT_LAN (or the older ACP_LAN), and HOST pins everything
  console.log('1️⃣ Resolving startup network settings...');
  expect(resolveStartupNetwork(false, {}).lanEnabled === false, 'LAN must default to off');
  expect(resolveStartupNetwork(true, {}).lanEnabled === true, 'Saved setting should turn LAN on');
  expect(resolveStartupNetwork(true, { CODEPIT_LAN: '0' }).lanEnabled === false, 'CODEPIT_LAN=0 should override the saved setting');
  expect(resolveStartupNetwork(true, { ACP_LAN: '0' }).lanEnabled === false, 'the older ACP_LAN=0 should still override the saved setting');
  expect(resolveStartupNetwork(false, { CODEPIT_LAN: '1', ACP_LAN: '0' }).lanEnabled === true, 'CODEPIT_LAN should win over ACP_LAN');
  expect(resolveStartupNetwork(false, { CODEPIT_LAN: '1' }).lanEnabled === true, 'CODEPIT_LAN=1 should override the saved setting');
  const pinned = resolveStartupNetwork(true, { HOST: '127.0.0.1', CODEPIT_LAN: '1' });
  expect(pinned.host === '127.0.0.1' && !pinned.lanEnabled && pinned.lockedReason, 'Explicit HOST must win and lock the switch');
  console.log('   ✅ Saved setting, CODEPIT_LAN and HOST applied in order\n');

  const handle = await startServer({ port: 0 });
  const { port, token } = handle;
  const auth = { 'x-codepit-token': token };
  const lan = { 'x-test-remote-ip': '192.168.1.50', ...auth };
  const openSockets: InstanceType<typeof WebSocket>[] = [];

  try {
    // 2. Starts off, and the host machine may switch it
    console.log('2️⃣ Reading network info from loopback...');
    const initial = await call(port, 'GET', '/api/network');
    expect(initial.status === 200, `GET /api/network should be 200, got ${initial.status}`);
    expect(initial.body.lanEnabled === false && initial.body.ips.length === 0, 'LAN should start off with no addresses');
    expect(initial.body.canToggle === true, 'Loopback client should be allowed to toggle');
    console.log('   ✅ LAN off, loopback client can toggle\n');

    // 2b. The web app manifest (home-screen install): open to anyone, start link signed only with a valid token
    console.log('2️⃣b Serving the web app manifest...');
    const remote = { 'x-test-remote-ip': '192.168.1.50' };
    const plain = await call(port, 'GET', '/manifest.webmanifest', { headers: remote });
    expect(plain.status === 200 && plain.body.start_url === '/' && plain.body.display === 'standalone', `Manifest without a token: ${plain.status} ${JSON.stringify(plain.body)}`);
    expect(plain.body.icons?.some((i: { sizes: string }) => i.sizes === '512x512'), 'Manifest should list a 512 px icon');
    const signed = await call(port, 'GET', `/manifest.webmanifest?token=${token}`, { headers: remote });
    expect(signed.body.start_url === `/?token=${token}`, `A valid token should go in the start link: ${signed.body.start_url}`);
    const forged = await call(port, 'GET', '/manifest.webmanifest?token=not-the-token', { headers: remote });
    expect(forged.body.start_url === '/', `An invalid token must not be echoed: ${forged.body.start_url}`);
    console.log('   ✅ Manifest served, start link carries only a valid token\n');

    // 3. A LAN client (valid token, same-origin) cannot switch it or see the switch as usable
    console.log('3️⃣ Rejecting the switch from a LAN client...');
    const lanInfo = await call(port, 'GET', '/api/network', { host: `192.168.1.5:${port}`, headers: lan });
    expect(lanInfo.status === 200 && lanInfo.body.canToggle === false, 'LAN client must see the switch as read-only');
    const lanToggle = await call(port, 'POST', '/api/network/lan', {
      host: `192.168.1.5:${port}`,
      headers: { ...lan, origin: `http://192.168.1.5:${port}` },
      body: { enabled: true },
    });
    expect(lanToggle.status === 403, `LAN client toggle should be 403, got ${lanToggle.status}`);
    const rebinding = await call(port, 'POST', '/api/network/lan', { host: `evil.example:${port}`, headers: auth, body: { enabled: true } });
    expect(rebinding.status === 403, `Loopback client with a foreign Host should be 403, got ${rebinding.status}`);
    const crossOrigin = await call(port, 'POST', '/api/network/lan', { headers: { origin: 'http://evil.example' }, body: { enabled: true } });
    expect(crossOrigin.status === 403, `Cross-origin toggle should be 403, got ${crossOrigin.status}`);
    const unchanged = await call(port, 'GET', '/api/network');
    expect(unchanged.body.lanEnabled === false, 'Rejected toggles must not change the state');
    expect(!fs.existsSync(getSettingsFile()), 'Rejected toggles must not write the setting');
    console.log('   ✅ LAN, rebinding and cross-origin toggles rejected, state untouched\n');

    const bad = await call(port, 'POST', '/api/network/lan', { body: { enabled: 'yes' } });
    expect(bad.status === 400, `Non-boolean enabled should be 400, got ${bad.status}`);

    // 4. Turning it on from loopback binds the interfaces, persisted privately
    console.log('4️⃣ Turning LAN on from loopback...');
    const on = await call(port, 'POST', '/api/network/lan', { body: { enabled: true } });
    expect(on.status === 200 && on.body.lanEnabled === true, `Toggle on should succeed, got ${on.status} ${JSON.stringify(on.body)}`);
    const expected = getLocalNetworkIps();
    const reached = [...on.body.ips, ...on.body.lanErrors.map((e: { address: string }) => e.address)].sort();
    expect(JSON.stringify(reached) === JSON.stringify([...expected].sort()), `Every interface should be listening or reported: ${JSON.stringify(on.body)}`);
    // The labelled links behind the QR code cover the same addresses, each with its own token link
    const labelled: { address: string; url: string; label: string }[] = on.body.lanInterfaces;
    expect(
      Array.isArray(labelled) && JSON.stringify(labelled.map((l) => l.address).sort()) === JSON.stringify([...on.body.ips].sort()),
      `lanInterfaces should list every listening address: ${JSON.stringify(labelled)}`
    );
    expect(
      labelled.every((l) => l.label && l.url === `http://${l.address}:${port}?token=${token}`),
      'Every labelled link should carry a label and the sign-in URL'
    );
    const settings = JSON.parse(fs.readFileSync(getSettingsFile(), 'utf8'));
    expect(settings.lanEnabled === true, 'Setting should be saved');
    expect((fs.statSync(getSettingsFile()).mode & 0o777) === 0o600, 'Settings file must be private (0600)');
    console.log(`   ✅ Listening on ${on.body.ips.join(', ') || '(no interfaces on this machine)'}, setting saved with mode 0600`);

    const address: string | undefined = on.body.ips[0];
    if (address) {
      // A real request over the interface: no loopback trust, so the token is required
      const noToken = await call(port, 'GET', '/api/sessions', { address, host: `${address}:${port}` });
      expect(noToken.status === 401, `LAN request without a token should be 401, got ${noToken.status}`);
      const withToken = await call(port, 'GET', '/api/network', { address, host: `${address}:${port}`, headers: auth });
      expect(withToken.status === 200 && withToken.body.canToggle === false, 'Real LAN request should work with the token and be read-only');
      const ws = new WebSocket(`ws://${address}:${port}/ws?token=${token}`);
      openSockets.push(ws);
      await once(ws, 'open');
      console.log(`   ✅ ${address} serves the API and WebSocket to a token holder\n`);

      // 5. Turning it off cuts connected LAN clients off at once
      console.log('5️⃣ Turning LAN off...');
      const closed = once(ws, 'close');
      const off = await call(port, 'POST', '/api/network/lan', { body: { enabled: false } });
      expect(off.status === 200 && off.body.lanEnabled === false && off.body.ips.length === 0, 'Toggle off should succeed');
      await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('LAN WebSocket survived LAN being turned off')), 2000))]);
      const refused = await call(port, 'GET', '/api/network', { address, host: `${address}:${port}`, headers: auth }).then(
        () => false,
        () => true
      );
      expect(refused, 'LAN address must refuse connections once LAN is off');
      console.log('   ✅ Open WebSocket dropped and the interface refuses new connections');
    } else {
      console.log('   ⚠️  No network interface on this machine, skipping the live LAN connection checks');
      const off = await call(port, 'POST', '/api/network/lan', { body: { enabled: false } });
      expect(off.status === 200 && off.body.lanEnabled === false, 'Toggle off should succeed');
    }
    expect(JSON.parse(fs.readFileSync(getSettingsFile(), 'utf8')).lanEnabled === false, 'Off should be saved');
    const local = await call(port, 'GET', '/api/network');
    expect(local.status === 200, 'Loopback listener must keep serving after LAN is turned off');
    console.log('   ✅ Setting saved, loopback still served\n');

    console.log('🎉 ALL LAN TESTS PASSED!');
  } finally {
    for (const ws of openSockets) ws.terminate();
    await handle.close();
    fs.rmSync(testAppDir, { recursive: true, force: true });
  }
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ LAN test suite failed:', err);
    process.exit(1);
  });
