import { spawn } from 'node:child_process';
import type { McpServerConfig } from '../types.js';
import { toAcpMcpServer } from './config.js';

// "Test connection": run the MCP handshake (initialize, then tools/list) the
// way an agent would, so a broken command, URL or token shows up here rather
// than as a tool that silently never appears in a session.

export interface McpProbeResult {
  ok: boolean;
  /** serverInfo reported by the MCP server. */
  server?: { name?: string; version?: string };
  tools?: Array<{ name: string; description?: string }>;
  error?: string;
  durationMs: number;
}

const PROTOCOL_VERSION = '2025-06-18';
// First runs of `npx -y …` / `uvx …` download the package, so allow for that
const STDIO_TIMEOUT_MS = 60_000;
const HTTP_TIMEOUT_MS = 20_000;
const MAX_TOOLS = 200;
// A handshake is a few KB; anything this big is a misbehaving server
const MAX_BYTES = 4 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;

// Process groups of stdio tests still running, killed if the app exits mid-test
const runningGroups = new Set<number>();
process.once('exit', () => {
  for (const pid of runningGroups) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
});

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-pid, signal);
    else process.kill(pid, signal);
  } catch {
    // already gone
  }
}

const initialize = (id: number) => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'codepit', version: '0.1.0' } },
});
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
const toolsList = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });

type Rpc = { id?: number | string; result?: any; error?: { message?: string } };

function summarize(init: Rpc, tools: Rpc, startedAt: number): McpProbeResult {
  if (init.error) return { ok: false, error: `initialize failed: ${init.error.message}`, durationMs: Date.now() - startedAt };
  const list: any[] = Array.isArray(tools.result?.tools) ? tools.result.tools : [];
  return {
    ok: true,
    server: init.result?.serverInfo,
    tools: list.slice(0, MAX_TOOLS).map((t) => ({ name: String(t?.name), description: typeof t?.description === 'string' ? t.description.slice(0, 200) : undefined })),
    error: tools.error ? `tools/list failed: ${tools.error.message}` : undefined,
    durationMs: Date.now() - startedAt,
  };
}

export async function probeMcpServer(server: McpServerConfig, cwd: string): Promise<McpProbeResult> {
  const startedAt = Date.now();
  try {
    if (server.transport === 'stdio') return await probeStdio(server, cwd, startedAt);
    if (server.transport === 'http') return await probeHttp(server, cwd, startedAt);
    return await probeSse(server, cwd, startedAt);
  } catch (err: any) {
    return { ok: false, error: describeError(err, server.url), durationMs: Date.now() - startedAt };
  }
}

/** undici reports every network failure as "fetch failed"; the useful part is in `cause`. */
function describeError(err: any, url?: string): string {
  const cause = err?.cause;
  let host = url ?? '';
  try {
    host = url ? new URL(url).host : '';
  } catch {
    // keep the raw url
  }
  switch (cause?.code) {
    case 'ECONNREFUSED':
      return `Connection refused: nothing is listening at ${host}`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Host not found: ${host}`;
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return `Timed out connecting to ${host}`;
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return `TLS certificate problem at ${host}: ${cause.message}`;
  }
  if (cause?.message === 'bad port') return `Port ${new URL(url ?? 'http://x').port} is on the blocked-ports list for HTTP clients; use another port`;
  if (err?.name === 'TimeoutError') return `No answer from ${host} within ${HTTP_TIMEOUT_MS / 1000}s`;
  const msg = err?.message || String(err);
  return cause?.message ? `${msg}: ${cause.message}` : msg;
}

function probeStdio(server: McpServerConfig, cwd: string, startedAt: number): Promise<McpProbeResult> {
  const spec = toAcpMcpServer(server, cwd) as { command: string; args: string[]; env: Array<{ name: string; value: string }> };
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      cwd,
      env: { ...process.env, ...Object.fromEntries(spec.env.map((e) => [e.name, e.value])) },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stderr = '';
    let buf = '';
    let initRes: Rpc | null = null;
    let settled = false;

    const pid = child.pid;
    if (pid) runningGroups.add(pid);
    let exited = false;
    child.on('close', () => {
      exited = true;
      if (pid) runningGroups.delete(pid);
    });

    const finish = (result: McpProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Many servers exit on EOF; the group signals cover npx/uvx wrappers, whose
      // real server is a grandchild, and servers that ignore SIGTERM
      child.stdin.end();
      killGroup(pid, 'SIGTERM');
      setTimeout(() => {
        if (!exited) killGroup(pid, 'SIGKILL');
        if (pid) runningGroups.delete(pid);
      }, KILL_GRACE_MS).unref();
      resolve(result);
    };
    const fail = (msg: string) => {
      const tail = stderr.trim().split('\n').slice(-4).join('\n');
      finish({ ok: false, error: tail ? `${msg}\n${tail}` : msg, durationMs: Date.now() - startedAt });
    };
    const send = (msg: object) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    const timer = setTimeout(() => fail(`No answer within ${STDIO_TIMEOUT_MS / 1000}s`), STDIO_TIMEOUT_MS);

    child.on('error', (err: NodeJS.ErrnoException) =>
      fail(err.code === 'ENOENT' ? `Command not found: ${spec.command}` : err.message)
    );
    // 'close' fires after stderr has drained, so the failure message includes the server's last words
    child.on('close', (code) => fail(`The server exited (code ${code}) before finishing the handshake`));
    child.stdin.on('error', () => {});
    child.stderr.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    child.stdout.on('data', (d) => {
      buf += d.toString();
      if (buf.length > MAX_BYTES) return fail(`The server wrote more than ${MAX_BYTES / 1024 / 1024} MB without a complete message`);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: Rpc;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // servers sometimes log to stdout; skip non-JSON lines
        }
        if (msg.id === 1) {
          initRes = msg;
          if (msg.error) return finish(summarize(msg, {}, startedAt));
          send(initialized);
          send(toolsList(2));
        } else if (msg.id === 2 && initRes) {
          return finish(summarize(initRes, msg, startedAt));
        }
      }
    });
    send(initialize(1));
  });
}

const headerObj = (server: McpServerConfig, cwd: string) => {
  const spec = toAcpMcpServer(server, cwd) as { url: string; headers: Array<{ name: string; value: string }> };
  return { url: spec.url, headers: Object.fromEntries(spec.headers.map((h) => [h.name, h.value])) };
};

/** Streamable HTTP: each request is a POST that answers with JSON or a short SSE stream. */
async function probeHttp(server: McpServerConfig, cwd: string, startedAt: number): Promise<McpProbeResult> {
  const { url, headers } = headerObj(server, cwd);
  const signal = AbortSignal.timeout(HTTP_TIMEOUT_MS);
  let sessionId: string | null = null;

  const post = async (body: object, expectReply: boolean): Promise<Rpc> => {
    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
    sessionId = res.headers.get('mcp-session-id') ?? sessionId;
    if (!res.ok) {
      const text = (await readCapped(res).catch(() => '')).slice(0, 300);
      const hint = res.status === 401 || res.status === 403 ? ' (check the token in the headers)' : '';
      throw new Error(`HTTP ${res.status} ${res.statusText}${hint}${text ? `: ${text}` : ''}`);
    }
    if (!expectReply) return {};
    const type = res.headers.get('content-type') || '';
    const text = await readCapped(res);
    if (type.includes('text/event-stream')) {
      for (const data of sseData(text)) {
        const msg = JSON.parse(data) as Rpc;
        if (msg.id === (body as any).id) return msg;
      }
      throw new Error('The server closed the stream without answering');
    }
    return JSON.parse(text);
  };

  const init = await post(initialize(1), true);
  if (init.error) return summarize(init, {}, startedAt);
  await post(initialized, false);
  const tools = await post(toolsList(2), true);
  return summarize(init, tools, startedAt);
}

/** Response body as text, failing past MAX_BYTES instead of buffering without limit. */
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
    if (text.length > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error(`The server answered with more than ${MAX_BYTES / 1024 / 1024} MB`);
    }
  }
}

function* sseData(text: string): Generator<string> {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (data) yield data;
  }
}

/** Legacy HTTP+SSE: GET opens the event stream, which first names the endpoint to POST to. */
async function probeSse(server: McpServerConfig, cwd: string, startedAt: number): Promise<McpProbeResult> {
  const { url, headers } = headerObj(server, cwd);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { ...headers, Accept: 'text/event-stream' }, signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let endpoint: string | null = null;
    let initRes: Rpc | null = null;

    const post = async (body: object) => {
      const r = await fetch(endpoint!, {
        method: 'POST',
        signal: controller.signal,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} from ${endpoint}`);
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('The server closed the event stream');
      buf += decoder.decode(value, { stream: true });
      if (buf.length > MAX_BYTES) throw new Error(`The event stream sent more than ${MAX_BYTES / 1024 / 1024} MB without a complete event`);
      let idx: number;
      while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
        const event = /^event:\s*(.*)$/m.exec(block)?.[1]?.trim() || 'message';
        const data = [...sseData(`${block}\n\n`)][0];
        if (!data) continue;
        if (event === 'endpoint') {
          const next = new URL(data, url);
          // The configured headers (often a bearer token) must not go to another origin
          if (next.origin !== new URL(url).origin) throw new Error(`The server named an endpoint on another origin (${next.origin}); refusing to send it the headers`);
          endpoint = next.toString();
          await post(initialize(1));
        } else if (event === 'message') {
          const msg = JSON.parse(data) as Rpc;
          if (msg.id === 1) {
            initRes = msg;
            if (msg.error) return summarize(msg, {}, startedAt);
            await post(initialized);
            await post(toolsList(2));
          } else if (msg.id === 2 && initRes) {
            return summarize(initRes, msg, startedAt);
          }
        }
      }
    }
  } catch (err: any) {
    if (controller.signal.aborted) throw new Error(`No answer within ${HTTP_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
