import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

// MCP support: config store, secret masking, presets, scoping, injection into
// ACP session/new, the connection probe and the HTTP API.

const testAppDir = path.join(os.tmpdir(), `codepit-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
process.env.NODE_ENV = 'test';
process.env.CODEPIT_APP_DIR = testAppDir;

const cfg = await import('../server/mcp/config.js');
const { presetToInput, listPresets } = await import('../server/mcp/presets.js');
const { probeMcpServer } = await import('../server/mcp/probe.js');
const { sessionManager } = await import('../server/acp/session-mgr.js');
const { store } = await import('../server/store.js');
const { apiRouter } = await import('../server/api.js');
const { default: express } = await import('express');

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function expectThrow(fn: () => unknown, match: RegExp, what: string) {
  try {
    await fn();
  } catch (err: any) {
    assert(match.test(err.message), `${what}: wrong error "${err.message}"`);
    return;
  }
  throw new Error(`${what}: expected an error`);
}

// A minimal stdio MCP server: answers initialize and tools/list
const FAKE_STDIO = `
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') reply(msg.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.2.3' } });
    if (msg.method === 'tools/list') reply(msg.id, { tools: [{ name: 'echo', description: 'Echo ' + (process.env.FAKE_TOKEN || '') }, { name: 'cwd', description: process.argv[2] }] });
  }
});
function reply(id, result) { process.stdout.write('log line that is not json\\n' + JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }
`;

async function run() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-mcp-ws-'));
  const fakePath = path.join(testAppDir, 'fake-mcp.cjs');
  fs.mkdirSync(testAppDir, { recursive: true });
  fs.writeFileSync(fakePath, FAKE_STDIO);

  try {
    console.log('1. Config store, validation and masking');
    await expectThrow(() => cfg.createMcpServer({ name: 'bad name!', transport: 'stdio', command: 'x' }), /Name must/, 'bad name');
    await expectThrow(() => cfg.createMcpServer({ name: 'x', transport: 'stdio' }), /needs a command/, 'missing command');
    await expectThrow(() => cfg.createMcpServer({ name: 'x', transport: 'http', url: 'ftp://a' }), /http/, 'bad url');
    const fake = cfg.createMcpServer({
      name: 'fake',
      transport: 'stdio',
      command: process.execPath,
      args: [fakePath, cfg.WORKSPACE_VAR],
      env: { FAKE_TOKEN: 'sekret-123', LOG_LEVEL: 'visible' },
    });
    await expectThrow(() => cfg.createMcpServer({ name: 'FAKE', transport: 'stdio', command: 'x' }), /already exists/, 'duplicate name');
    const stat = fs.statSync(cfg.getMcpConfigFile());
    assert((stat.mode & 0o077) === 0, `mcp.json must be owner-only, got ${(stat.mode & 0o777).toString(8)}`);
    const view = cfg.toView(fake);
    assert(view.env?.FAKE_TOKEN === cfg.MASK && view.env?.LOG_LEVEL === 'visible', 'secret env masked, plain env shown');
    // Sending the mask back keeps the stored secret
    const edited = cfg.updateMcpServer(fake.id, { ...view, description: 'edited' });
    assert(edited.env?.FAKE_TOKEN === 'sekret-123' && edited.description === 'edited', 'mask round-trip keeps secret');
    const remote = cfg.createMcpServer({ name: 'remote', transport: 'sse', url: 'http://127.0.0.1:1/sse', headers: { Authorization: 'Bearer t' }, scope: 'claude' });
    assert(cfg.toView(remote).headers?.Authorization === cfg.MASK, 'headers always masked');
    // Masking beyond name patterns: unknown env names, URL credentials, secret flags
    const leaky = cfg.createMcpServer({
      name: 'leaky',
      transport: 'stdio',
      command: 'tool',
      args: ['--api-key', 'sk-live-1', '--token=tok-2', '-y', 'pkg'],
      env: { GH_PAT: 'pat-3', DATA_DIR: '/data' },
    });
    const leakyView = cfg.toView(leaky);
    assert(leakyView.env?.GH_PAT === cfg.MASK && leakyView.env?.DATA_DIR === '/data', 'env masked unless plainly not secret');
    assert(!JSON.stringify(leakyView).match(/sk-live-1|tok-2|pat-3/), `flag values masked: ${JSON.stringify(leakyView.args)}`);
    assert(leakyView.args?.[3] === '-y' && leakyView.args?.[4] === 'pkg', 'ordinary args shown');
    const leakyBack = cfg.updateMcpServer(leaky.id, leakyView);
    assert(leakyBack.args?.join(' ') === '--api-key sk-live-1 --token=tok-2 -y pkg' && leakyBack.env?.GH_PAT === 'pat-3', 'masked args round-trip');
    await expectThrow(
      () => cfg.updateMcpServer(leaky.id, { ...leakyView, args: ['--api-key', `x${cfg.MASK}`] }),
      /hidden part/,
      'half-edited masked arg rejected'
    );
    const keyed = cfg.createMcpServer({ name: 'keyed', transport: 'http', url: 'https://u:pw-4@mcp.example.com/mcp?api_key=k-5&x=1' });
    const keyedView = cfg.toView(keyed);
    assert(!keyedView.url?.match(/pw-4|k-5/) && keyedView.url?.includes('mcp.example.com/mcp'), `url masked: ${keyedView.url}`);
    assert(cfg.updateMcpServer(keyed.id, keyedView).url === keyed.url, 'masked url round-trip');
    // A PUT that leaves fields out keeps them
    const partial = cfg.updateMcpServer(keyed.id, { name: 'keyed', transport: 'http', url: keyedView.url });
    assert(partial.url === keyed.url && partial.scope === keyed.scope && partial.enabled === keyed.enabled, 'partial update merges');
    cfg.deleteMcpServer(leaky.id);
    cfg.deleteMcpServer(keyed.id);

    // A corrupt file is reported, never silently replaced
    const good = fs.readFileSync(cfg.getMcpConfigFile(), 'utf8');
    fs.writeFileSync(cfg.getMcpConfigFile(), good.replace(/}\s*$/, ',}'));
    await expectThrow(() => cfg.listMcpServers(), /not valid JSON/, 'corrupt file reported');
    await expectThrow(() => cfg.createMcpServer({ name: 'x', transport: 'stdio', command: 'x' }), /not valid JSON/, 'write refused');
    fs.writeFileSync(cfg.getMcpConfigFile(), good);
    console.log('   ok');

    console.log('2. Presets');
    assert(listPresets().length >= 6, 'preset catalog');
    await expectThrow(() => presetToInput('github', {}), /required/, 'github needs a token');
    const gh = presetToInput('github', { GITHUB_TOKEN: 'ghp_abc' });
    assert(gh.headers?.Authorization === 'Bearer ghp_abc' && gh.transport === 'http', 'github preset fills header');
    const mem = presetToInput('memory');
    assert(mem.env?.MEMORY_FILE_PATH === path.join(testAppDir, 'mcp-memory.jsonl'), 'memory file under app dir');
    const fsPreset = presetToInput('filesystem');
    assert(fsPreset.args?.includes(cfg.WORKSPACE_VAR), 'filesystem keeps ${workspace} for session time');
    console.log('   ok');

    console.log('3. Scope and transport filtering');
    const all = cfg.listMcpServers();
    const forCodex = cfg.resolveSessionMcpServers('codex', workDir, { http: true, sse: false }, all);
    assert(forCodex.info.attached.join() === 'fake' && forCodex.info.skipped.length === 0, 'codex gets only the all-scope server');
    const forClaudeNoSse = cfg.resolveSessionMcpServers('claude', workDir, { http: true }, all);
    assert(forClaudeNoSse.info.skipped[0]?.name === 'remote', 'sse server skipped without the capability');
    const stdioSpec = forCodex.servers[0] as any;
    assert(stdioSpec.args[1] === workDir, '${workspace} expanded to the session folder');
    assert(stdioSpec.env.some((e: any) => e.name === 'FAKE_TOKEN' && e.value === 'sekret-123'), 'real secret sent to the agent');
    cfg.setMcpServerEnabled(remote.id, false);
    assert(cfg.resolveSessionMcpServers('claude', workDir, { http: true, sse: true }).info.attached.join() === 'fake', 'disabled server left out');
    console.log('   ok');

    console.log('4. Probe (stdio, streamable HTTP, SSE)');
    const stdio = await probeMcpServer(cfg.getMcpServer(fake.id)!, workDir);
    assert(stdio.ok && stdio.server?.version === '1.2.3', `stdio probe: ${stdio.error}`);
    assert(stdio.tools?.map((t) => t.name).join() === 'echo,cwd' && stdio.tools[1].description === workDir, 'stdio tools + workspace arg');
    const missing = cfg.createMcpServer({ name: 'missing', transport: 'stdio', command: 'definitely-not-a-command-xyz' });
    const bad = await probeMcpServer(missing, workDir);
    assert(!bad.ok && /not found/i.test(bad.error || ''), `missing command reported: ${bad.error}`);
    cfg.deleteMcpServer(missing.id);

    const mcpHttp = http.createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer good') {
        res.writeHead(401).end('nope');
        return;
      }
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        if (req.method === 'GET' && req.url === '/sse') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('event: endpoint\ndata: /messages\n\n');
          sseClients.push(res);
          return;
        }
        const msg = JSON.parse(body || '{}');
        const result =
          msg.method === 'initialize'
            ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'http-fake', version: '9' } }
            : msg.method === 'tools/list'
              ? { tools: [{ name: 'search' }] }
              : null;
        if (req.url === '/messages') {
          res.writeHead(202).end();
          if (result) for (const c of sseClients) c.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
          return;
        }
        if (!result) {
          res.writeHead(202).end();
          return;
        }
        // Answer initialize as JSON and tools/list as an SSE stream: both are legal
        if (msg.method === 'initialize') {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 's1' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
        } else {
          assert(req.headers['mcp-session-id'] === 's1', 'session id echoed');
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
        }
      });
    });
    const sseClients: http.ServerResponse[] = [];
    mcpHttp.listen(0, '127.0.0.1');
    await once(mcpHttp, 'listening');
    const base = `http://127.0.0.1:${(mcpHttp.address() as AddressInfo).port}`;
    const h = await probeMcpServer({ ...fake, transport: 'http', url: `${base}/mcp`, headers: { Authorization: 'Bearer good' } }, workDir);
    assert(h.ok && h.server?.name === 'http-fake' && h.tools?.[0]?.name === 'search', `http probe: ${h.error}`);
    const unauth = await probeMcpServer({ ...fake, transport: 'http', url: `${base}/mcp`, headers: { Authorization: 'Bearer bad' } }, workDir);
    assert(!unauth.ok && /401/.test(unauth.error || '') && /token/.test(unauth.error || ''), `401 explained: ${unauth.error}`);
    const closed = http.createServer().listen(0, '127.0.0.1');
    await once(closed, 'listening');
    const closedPort = (closed.address() as AddressInfo).port;
    closed.close();
    const refused = await probeMcpServer({ ...fake, transport: 'http', url: `http://127.0.0.1:${closedPort}/mcp` }, workDir);
    assert(!refused.ok && /Connection refused/.test(refused.error || ''), `refused explained: ${refused.error}`);
    const sse = await probeMcpServer({ ...fake, transport: 'sse', url: `${base}/sse`, headers: { Authorization: 'Bearer good' } }, workDir);
    assert(sse.ok && sse.tools?.[0]?.name === 'search', `sse probe: ${sse.error}`);
    for (const c of sseClients) c.end();
    mcpHttp.closeAllConnections();
    mcpHttp.close();
    console.log('   ok');

    console.log('5. Injection into a real ACP session (mock agent)');
    store.clear();
    sessionManager.init();
    const session = await sessionManager.createSession({ agentId: 'mock', cwd: workDir, title: 'MCP injection' });
    const started = sessionManager.getSession(session.id)!;
    assert(started.mcp?.attached.join() === 'fake', `session records attached servers: ${JSON.stringify(started.mcp)}`);
    await sessionManager.sendPrompt(session.id, 'which mcp servers do you have?');
    const lastAgentReply = () => {
      const last = sessionManager.getSession(session.id)!.turns.at(-1);
      return last?.role === 'agent' ? last.content || '' : '';
    };
    for (let i = 0; i < 100 && !lastAgentReply().includes('MCP servers'); i++) await new Promise((r) => setTimeout(r, 100));
    const reply = lastAgentReply();
    assert(reply.includes('`fake` (stdio)') && reply.includes(workDir), `agent saw the server with the workspace expanded: ${reply}`);
    assert(!reply.includes('remote'), 'disabled server not injected');
    console.log('   ok');

    console.log('6. HTTP API');
    const app = express();
    app.use(express.json());
    app.use('/api', apiRouter);
    const srv = app.listen(0, '127.0.0.1');
    await once(srv, 'listening');
    const api = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/mcp`;
    const call = async (method: string, url: string, body?: unknown) => {
      const r = await fetch(`${api}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, json: (await r.json()) as any };
    };
    const listed = await call('GET', '/servers');
    assert(!JSON.stringify(listed.json).includes('sekret-123'), 'secrets never leave the API');
    const badScope = await call('POST', '/servers', { name: 'x', transport: 'stdio', command: 'x', scope: 'nope' });
    assert(badScope.status === 400, 'unknown scope rejected');
    const added = await call('POST', '/servers/from-preset', { presetId: 'brave-search', inputs: { BRAVE_API_KEY: 'bsa-secret' }, scope: 'codex' });
    assert(added.status === 200 && added.json.server.env.BRAVE_API_KEY === cfg.MASK && added.json.server.scope === 'codex', 'preset via API masked');
    const tested = await call('POST', `/servers/${fake.id}/test`, { cwd: workDir });
    assert(tested.json.result.ok && tested.json.cwd === workDir, 'test endpoint');
    const toggled = await call('PATCH', `/servers/${added.json.server.id}/enabled`, { enabled: false });
    assert(toggled.json.server.enabled === false, 'toggle');
    assert((await call('DELETE', `/servers/${added.json.server.id}`)).status === 200, 'delete');
    assert((await call('DELETE', `/servers/${added.json.server.id}`)).status === 404, 'delete twice is 404');
    const eco = await call('GET', '/ecosystems');
    assert(Array.isArray(eco.json.ecosystems) && eco.json.ecosystems.length === 3, 'ecosystems listed');
    srv.close();
    console.log('   ok');

    console.log('\nMCP tests passed');
  } finally {
    sessionManager.shutdown();
    store.clear();
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(testAppDir, { recursive: true, force: true });
  }
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error('\nMCP tests failed:', err);
    process.exit(1);
  }
);
