import fs from 'node:fs';
import http from 'node:http';
import type { Socket } from 'node:net';
import { getLocalNetworkIps } from './network.js';
import { ensurePrivateDir, getAppDir, getSettingsFile, FILE_MODE } from './paths.js';
import { isLoopbackBind } from './security.js';

export interface LanBindError {
  address: string;
  error: string;
}

export interface LanStatus {
  enabled: boolean;
  /** Address the always-on listener is bound to: loopback, or whatever HOST says. */
  host: string;
  port: number;
  /** Interface addresses LAN devices can reach the server on right now. */
  addresses: string[];
  /** Interfaces that could not be listened on, with the reason. */
  errors: LanBindError[];
  /** Set when LAN access is fixed for this run and the UI must not offer to change it. */
  lockedReason?: string;
}

interface Listener {
  server: http.Server;
  sockets: Set<Socket>;
}

export interface LanConfig {
  handler: http.RequestListener;
  /** Adds the WebSocket upgrade handling to a listener. */
  attach: (server: http.Server) => void;
  port: number;
  host: string;
  enabled: boolean;
  lockedReason?: string;
}

interface StoredSettings {
  lanEnabled?: boolean;
}

function readSettings(): StoredSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(getSettingsFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function readStoredLanEnabled(): boolean {
  return readSettings().lanEnabled === true;
}

function writeStoredLanEnabled(enabled: boolean): void {
  ensurePrivateDir(getAppDir());
  const file = getSettingsFile();
  fs.writeFileSync(file, JSON.stringify({ ...readSettings(), lanEnabled: enabled }, null, 2), { mode: FILE_MODE });
  // mode only applies when the file is created; keep an older file private too
  try {
    fs.chmodSync(file, FILE_MODE);
  } catch {
    // best-effort chmod
  }
}

/**
 * LAN access as extra listeners next to the loopback one: one HTTP server per
 * non-internal IPv4 address, all serving the same app and WebSocket endpoints.
 * Binding 0.0.0.0 instead would collide with the loopback listener on the same
 * port, and could not be narrowed back down without dropping local clients too.
 * Turning LAN off closes these servers and destroys their sockets, upgraded
 * WebSockets included, so connected devices are cut off at once.
 */
class LanAccess {
  private config: LanConfig | null = null;
  private listeners = new Map<string, Listener>();
  private errors = new Map<string, string>();
  // Changes run one at a time so a quick on-off-on cannot interleave binds and closes
  private queue: Promise<unknown> = Promise.resolve();

  async start(config: LanConfig): Promise<LanStatus> {
    this.config = config;
    return this.serialize(() => this.sync());
  }

  status(): LanStatus {
    const c = this.config;
    if (!c) return { enabled: false, host: '127.0.0.1', port: 0, addresses: [], errors: [] };
    // With an explicit HOST the one listener already covers whatever it binds
    const addresses = c.lockedReason
      ? isLoopbackBind(c.host) ? [] : getLocalNetworkIps()
      : [...this.listeners.keys()];
    return {
      enabled: c.enabled,
      host: c.host,
      port: c.port,
      addresses,
      errors: [...this.errors].map(([address, error]) => ({ address, error })),
      lockedReason: c.lockedReason,
    };
  }

  /** Persists the choice and applies it. Resolves once every interface has been tried. */
  async setEnabled(enabled: boolean): Promise<LanStatus> {
    const c = this.config;
    if (!c) throw new Error('Server is not running');
    if (c.lockedReason) throw new Error(c.lockedReason);
    return this.serialize(async () => {
      c.enabled = enabled;
      writeStoredLanEnabled(enabled);
      return this.sync();
    });
  }

  /** Follows interfaces that came up or went away since the last check (Wi-Fi joins, VPNs). */
  async refresh(): Promise<LanStatus> {
    if (!this.config || this.config.lockedReason) return this.status();
    return this.serialize(() => this.sync());
  }

  async close(): Promise<void> {
    await this.serialize(async () => {
      for (const address of [...this.listeners.keys()]) this.stop(address);
      this.errors.clear();
    });
    this.config = null;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async sync(): Promise<LanStatus> {
    const c = this.config!;
    if (!c.lockedReason) {
      const wanted = new Set(c.enabled ? getLocalNetworkIps() : []);
      for (const address of [...this.listeners.keys()]) {
        if (!wanted.has(address)) this.stop(address);
      }
      this.errors.clear();
      await Promise.all([...wanted].filter((a) => !this.listeners.has(a)).map((a) => this.listen(a)));
    }
    return this.status();
  }

  private async listen(address: string): Promise<void> {
    const c = this.config!;
    const server = http.createServer(c.handler);
    const sockets = new Set<Socket>();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    c.attach(server);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(c.port, address, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (err: any) {
      this.errors.set(address, bindErrorMessage(err, c.port));
      server.close();
      return;
    }
    server.on('error', (err) => console.error(`[codepit] LAN listener ${address} failed:`, err));
    this.listeners.set(address, { server, sockets });
  }

  private stop(address: string): void {
    const listener = this.listeners.get(address);
    if (!listener) return;
    this.listeners.delete(address);
    listener.server.close();
    for (const socket of listener.sockets) socket.destroy();
  }
}

function bindErrorMessage(err: any, port: number): string {
  if (err?.code === 'EADDRINUSE') return `Port ${port} is already in use on this address`;
  if (err?.code === 'EADDRNOTAVAIL') return 'This address is no longer available';
  if (err?.code === 'EACCES') return `Not allowed to listen on port ${port}`;
  return err?.message || String(err);
}

export const lanAccess = new LanAccess();
