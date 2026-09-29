import os from 'node:os';
import type { IncomingMessage } from 'node:http';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackAddress(ip: string | undefined): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * Remote address of the request. The `x-test-remote-ip` override exists only so test
 * scripts can simulate LAN clients; outside NODE_ENV=test any client could send it to
 * pose as loopback and skip token auth, so it is ignored there.
 */
export function getRemoteAddress(req: IncomingMessage): string | undefined {
  if (process.env.NODE_ENV === 'test') {
    const simulated = req.headers['x-test-remote-ip'];
    if (typeof simulated === 'string' && simulated) return simulated;
  }
  return req.socket.remoteAddress;
}

function localInterfaceAddresses(): Set<string> {
  const out = new Set<string>();
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) out.add(iface.address);
  }
  return out;
}

/** Hostname of a `host[:port]` value, lower-cased, keeping IPv6 brackets. Null when unparsable. */
function hostnameOf(hostHeader: string): string | null {
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isLocalHostname(hostname: string): boolean {
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  const bare = hostname.replace(/^\[|\]$/g, '');
  return localInterfaceAddresses().has(bare);
}

/**
 * Host header allowlist for requests trusted only because they come from loopback.
 * Without it a DNS-rebinding page (evil.example resolving to 127.0.0.1) would be
 * same-origin with the server and pass the Origin check.
 */
export function isTrustedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const hostname = hostnameOf(hostHeader);
  return hostname !== null && isLocalHostname(hostname);
}

/**
 * Origin check for browser-initiated requests. Requests without an Origin header
 * (curl, scripts, same-origin GETs) are allowed; a present Origin must be local
 * (loopback or one of this machine's addresses, any port, so the Vite dev server
 * on 5280 works) or match the Host the request was sent to.
 */
export function isAllowedOrigin(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (!origin) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (isLocalHostname(parsed.hostname.toLowerCase())) return true;
  return Boolean(hostHeader) && parsed.host.toLowerCase() === hostHeader!.toLowerCase();
}

export type AccessDecision = { ok: true } | { ok: false; status: 401 | 403; error: string };

/**
 * Shared gate for /api requests and WebSocket upgrades: reject foreign Origins, then
 * accept a valid token, or a loopback client addressing the server by a local Host name.
 */
export function checkAccess(req: IncomingMessage, reqToken: string | undefined, token: string): AccessDecision {
  const origin = req.headers.origin;
  if (!isAllowedOrigin(typeof origin === 'string' ? origin : undefined, req.headers.host)) {
    return { ok: false, status: 403, error: 'Forbidden: cross-origin request rejected' };
  }
  if (reqToken && reqToken === token) return { ok: true };
  if (isLoopbackAddress(getRemoteAddress(req)) && isTrustedHost(req.headers.host)) return { ok: true };
  return { ok: false, status: 401, error: 'Unauthorized: missing or invalid x-acp-token' };
}

/** True when HOST binds only the loopback interface, so LAN clients cannot connect. */
export function isLoopbackBind(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
