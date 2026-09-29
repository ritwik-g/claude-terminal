import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type * as acp from '@agentclientprotocol/sdk';
import { getAppDir, ensurePrivateDir, FILE_MODE } from '../paths.js';
import type { McpServerConfig, McpServerInput, McpServerView, McpTransport, SessionMcpInfo } from '../types.js';

// App-level MCP servers, configured once and handed to every ACP session the
// scope allows. Stored in <app dir>/mcp.json with owner-only permissions
// because env values and headers often hold API tokens.

/** Placeholder the API sends instead of a secret; sending it back keeps the stored value. */
export const MASK = '••••••••';

/** Replaced with the session's folder when the server is handed to an agent. */
export const WORKSPACE_VAR = '${workspace}';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// Env values are secret unless the name says otherwise: paths, dirs and a few well-known settings
const PLAIN_ENV_RE = /^(PATH|HOME|USER|SHELL|LANG|LC_[A-Z]+|TZ|NODE_ENV|NODE_OPTIONS|DEBUG|LOG_LEVEL|PYTHONPATH)$|_(PATH|DIR|FILE|HOME|ROOT|MODE|LEVEL|PORT|HOST)$/i;
// Arguments that carry a secret in the next arg or after `=`: --api-key, --token, --password, ...
const SECRET_FLAG_RE = /^--?[\w-]*(key|token|secret|pass(word)?|auth|cred)[\w-]*$/i;
const TRANSPORTS: McpTransport[] = ['stdio', 'http', 'sse'];

export class McpConfigError extends Error {}

export function getMcpConfigFile(): string {
  return path.join(getAppDir(), 'mcp.json');
}

/**
 * Only a missing file means "no servers". A file that can't be read or parsed
 * throws, so writes are refused instead of overwriting the saved servers.
 */
function readAll(): McpServerConfig[] {
  let text: string;
  try {
    text = fs.readFileSync(getMcpConfigFile(), 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw new Error(`Can't read ${getMcpConfigFile()}: ${err.message}`);
  }
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch (err: any) {
    throw new Error(`${getMcpConfigFile()} is not valid JSON (${err.message}). Fix or remove it; nothing was changed.`);
  }
  if (!Array.isArray(raw?.servers)) throw new Error(`${getMcpConfigFile()} has no "servers" list. Fix or remove it; nothing was changed.`);
  return raw.servers;
}

function writeAll(servers: McpServerConfig[]): void {
  ensurePrivateDir(getAppDir());
  const file = getMcpConfigFile();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, servers }, null, 2), { mode: FILE_MODE, encoding: 'utf8' });
  fs.renameSync(tmp, file);
}

export function listMcpServers(): McpServerConfig[] {
  return readAll();
}

export function getMcpServer(id: string): McpServerConfig | null {
  return readAll().find((s) => s.id === id) ?? null;
}

const isSecretEnv = (key: string) => !PLAIN_ENV_RE.test(key);

function maskRecord(rec: Record<string, string> | undefined, isSecret: (key: string) => boolean): Record<string, string> | undefined {
  if (!rec) return rec;
  return Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, v && isSecret(k) ? MASK : v]));
}

/** Hide URL credentials: the password in userinfo and every query value. */
function maskUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (!u.password && !u.username && !u.search) return url;
    let out = `${u.protocol}//`;
    if (u.username || u.password) out += `${u.username}${u.password ? `:${MASK}` : ''}@`;
    out += `${u.host}${u.pathname}`;
    if (u.search) out += `?${[...u.searchParams.keys()].map((k) => `${encodeURIComponent(k)}=${MASK}`).join('&')}`;
    return out + u.hash;
  } catch {
    return url;
  }
}

/** Hide the value of secret-looking flags: `--api-key sk-1` and `--api-key=sk-1`. */
function maskArgs(args: string[] | undefined): string[] | undefined {
  if (!args) return args;
  return args.map((a, i) => {
    const eq = a.indexOf('=');
    if (eq > 0 && SECRET_FLAG_RE.test(a.slice(0, eq))) return `${a.slice(0, eq)}=${MASK}`;
    if (i > 0 && SECRET_FLAG_RE.test(args[i - 1]) && !a.startsWith('-')) return MASK;
    return a;
  });
}

/** The browser-facing shape: secrets in env, headers, URL and flags replaced by MASK. */
export function toView(server: McpServerConfig): McpServerView {
  return {
    ...server,
    args: maskArgs(server.args),
    env: maskRecord(server.env, isSecretEnv),
    url: maskUrl(server.url),
    headers: maskRecord(server.headers, () => true),
  };
}

function cleanRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new McpConfigError(`${label} must be an object of strings`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = k.trim();
    if (!key) continue;
    if (typeof v !== 'string') throw new McpConfigError(`${label} "${key}" must be a string`);
    out[key] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Keep the stored value wherever the client sent MASK back unchanged. */
function unmask(next: Record<string, string> | undefined, prev: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!next) return next;
  return Object.fromEntries(Object.entries(next).map(([k, v]) => [k, v === MASK ? prev?.[k] ?? '' : v]));
}

/**
 * A URL or argument comes back exactly as masked when the user left it alone:
 * restore the stored one. Anything else still holding MASK was half-edited.
 */
function unmaskValue(next: string | undefined, prev: string | undefined, masked: string | undefined, label: string): string | undefined {
  if (next === undefined || !next.includes(MASK)) return next;
  if (next === masked) return prev;
  throw new McpConfigError(`${label} still has a hidden part (${MASK}). Type the full value again.`);
}

function validate(input: McpServerInput, others: McpServerConfig[]): Omit<McpServerConfig, 'id' | 'createdAt' | 'updatedAt'> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!NAME_RE.test(name)) {
    throw new McpConfigError('Name must start with a letter or digit and use only letters, digits, "-" or "_" (max 64)');
  }
  if (others.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
    throw new McpConfigError(`A server named "${name}" already exists`);
  }
  const transport = input.transport as McpTransport;
  if (!TRANSPORTS.includes(transport)) throw new McpConfigError('Transport must be stdio, http or sse');
  const scope = typeof input.scope === 'string' && input.scope ? input.scope : 'all';

  const base = {
    name,
    transport,
    enabled: input.enabled !== false,
    scope,
    presetId: typeof input.presetId === 'string' ? input.presetId : undefined,
    description: typeof input.description === 'string' ? input.description.slice(0, 200) : undefined,
  };

  if (transport === 'stdio') {
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (!command) throw new McpConfigError('A stdio server needs a command');
    if (input.args != null && (!Array.isArray(input.args) || input.args.some((a) => typeof a !== 'string'))) {
      throw new McpConfigError('Arguments must be a list of strings');
    }
    return { ...base, command, args: (input.args ?? []).filter((a) => a !== ''), env: cleanRecord(input.env, 'Environment variable') };
  }

  const url = typeof input.url === 'string' ? input.url.trim() : '';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new McpConfigError('Enter a full URL, e.g. https://example.com/mcp');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new McpConfigError('The URL must start with http:// or https://');
  return { ...base, url, headers: cleanRecord(input.headers, 'Header') };
}

export function createMcpServer(input: McpServerInput): McpServerConfig {
  const all = readAll();
  const now = Date.now();
  const server: McpServerConfig = { id: `mcp-${crypto.randomBytes(6).toString('hex')}`, ...validate(input, all), createdAt: now, updatedAt: now };
  writeAll([...all, server]);
  return server;
}

export function updateMcpServer(id: string, input: McpServerInput): McpServerConfig {
  const all = readAll();
  const prev = all.find((s) => s.id === id);
  if (!prev) throw new McpConfigError('MCP server not found');
  // Fields the client left out keep their stored values
  const merged: McpServerInput = { ...prev, ...input };
  const prevArgs = maskArgs(prev.args) ?? [];
  merged.args = merged.args?.map((a, i) => unmaskValue(a, prev.args?.[i], prevArgs[i], `Argument ${i + 1}`) ?? '');
  merged.url = unmaskValue(merged.url, prev.url, maskUrl(prev.url), 'The URL');
  merged.env = unmask(merged.env as Record<string, string> | undefined, prev.env);
  merged.headers = unmask(merged.headers as Record<string, string> | undefined, prev.headers);
  const next: McpServerConfig = {
    ...validate(merged, all.filter((s) => s.id !== id)),
    id,
    createdAt: prev.createdAt,
    updatedAt: Date.now(),
  };
  writeAll(all.map((s) => (s.id === id ? next : s)));
  return next;
}

export function setMcpServerEnabled(id: string, enabled: boolean): McpServerConfig {
  const all = readAll();
  const prev = all.find((s) => s.id === id);
  if (!prev) throw new McpConfigError('MCP server not found');
  const next = { ...prev, enabled, updatedAt: Date.now() };
  writeAll(all.map((s) => (s.id === id ? next : s)));
  return next;
}

export function deleteMcpServer(id: string): boolean {
  const all = readAll();
  const rest = all.filter((s) => s.id !== id);
  if (rest.length === all.length) return false;
  writeAll(rest);
  return true;
}

const expand = (value: string, cwd: string) => value.split(WORKSPACE_VAR).join(cwd);
const toPairs = (rec: Record<string, string> | undefined, cwd: string) =>
  Object.entries(rec ?? {}).map(([name, value]) => ({ name, value: expand(value, cwd) }));

/** The ACP `session/new` entry for one configured server. */
export function toAcpMcpServer(server: McpServerConfig, cwd: string): acp.McpServer {
  if (server.transport === 'stdio') {
    return {
      name: server.name,
      command: expand(server.command ?? '', cwd),
      args: (server.args ?? []).map((a) => expand(a, cwd)),
      env: toPairs(server.env, cwd),
    };
  }
  return { type: server.transport, name: server.name, url: expand(server.url ?? '', cwd), headers: toPairs(server.headers, cwd) };
}

export const appliesTo = (server: McpServerConfig, agentId: string) => server.scope === 'all' || server.scope === agentId;

/**
 * Pick the enabled servers in scope for an agent, dropping transports the agent
 * did not advertise (stdio is mandatory in ACP; http and sse are opt-in).
 */
export function resolveSessionMcpServers(
  agentId: string,
  cwd: string,
  caps: { http?: boolean; sse?: boolean } | undefined,
  servers: McpServerConfig[] = readAll()
): { servers: acp.McpServer[]; info: SessionMcpInfo } {
  const out: acp.McpServer[] = [];
  const info: SessionMcpInfo = { attached: [], skipped: [] };
  for (const s of servers) {
    if (!s.enabled || !appliesTo(s, agentId)) continue;
    if (s.transport !== 'stdio' && !caps?.[s.transport]) {
      info.skipped.push({ name: s.name, reason: `This agent does not accept ${s.transport.toUpperCase()} MCP servers` });
      continue;
    }
    out.push(toAcpMcpServer(s, cwd));
    info.attached.push(s.name);
  }
  return { servers: out, info };
}
