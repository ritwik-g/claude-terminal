import { execFile } from 'node:child_process';
import os from 'node:os';
import { isLoopbackBind } from './security.js';

/**
 * Returns a list of local IPv4 network addresses (e.g. 192.168.x.x, 10.x.x.x).
 * Wi-Fi and Ethernet interfaces (en*, eth*, wl*) are prioritized at the top of the list.
 */
export function getLocalNetworkIps(): string[] {
  const interfaces = os.networkInterfaces();
  const addresses: string[] = [];

  for (const [name, ifaces] of Object.entries(interfaces)) {
    if (!ifaces) continue;
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        if (name.startsWith('en') || name.startsWith('eth') || name.startsWith('wl')) {
          addresses.unshift(iface.address);
        } else {
          addresses.push(iface.address);
        }
      }
    }
  }

  return [...new Set(addresses)];
}

export interface StartupNetwork {
  /** Address of the always-on listener. */
  host: string;
  lanEnabled: boolean;
  /** Present when HOST fixes the binding, so LAN access cannot be switched at runtime. */
  lockedReason?: string;
}

/**
 * How the server starts listening. Loopback always, plus LAN listeners when LAN
 * access is on: the saved setting decides, `ACP_LAN` overrides it for this run,
 * and an explicit HOST replaces the whole scheme with that one bind address.
 */
export function resolveStartupNetwork(storedLanEnabled: boolean, env: NodeJS.ProcessEnv = process.env): StartupNetwork {
  if (env.HOST) {
    return {
      host: env.HOST,
      lanEnabled: !isLoopbackBind(env.HOST),
      lockedReason: `The server was started with HOST=${env.HOST}, which fixes the address it listens on. Start it without HOST to switch LAN access here.`,
    };
  }
  const flag = env.ACP_LAN?.toLowerCase();
  const lanEnabled = flag === '1' || flag === 'true' ? true : flag === '0' || flag === 'false' ? false : storedLanEnabled;
  return { host: '127.0.0.1', lanEnabled };
}

export type InterfaceKind = 'wifi' | 'ethernet' | 'other' | 'vpn' | 'virtual';

export interface LanInterface {
  address: string;
  /** OS interface name, e.g. en0, wlan0, bridge100. Empty when the address is no longer on any interface. */
  name: string;
  kind: InterfaceKind;
  /** Plain-words name for the UI, e.g. "Wi-Fi" or "Virtual network". */
  label: string;
}

// Interfaces a phone on the same Wi-Fi can almost never reach: hypervisor and
// container bridges, and VPN tunnels. Matched on the OS interface name.
const VIRTUAL_IFACE = /^(bridge\d{3,}|vmenet|vmnet|vboxnet|virbr|docker|br-|veth|lxc|lxd|cni|flannel|cali|podman|vEthernet)/i;
const VPN_IFACE = /^(utun|tun|tap|wg|ppp|ipsec|tailscale|zt)/i;

/**
 * What kind of network an interface is, from its name and, on macOS, the
 * hardware port it belongs to (`networksetup` knows en0 is Wi-Fi on a laptop
 * but Ethernet on a Mac mini; the name alone can't tell).
 */
export function classifyInterface(name: string, hardwarePort?: string): { kind: InterfaceKind; label: string } {
  if (hardwarePort) {
    if (/wi-?fi|airport|wireless/i.test(hardwarePort)) return { kind: 'wifi', label: 'Wi-Fi' };
    if (/ethernet|lan|usb/i.test(hardwarePort)) return { kind: 'ethernet', label: 'Ethernet' };
    return { kind: 'other', label: hardwarePort };
  }
  if (VIRTUAL_IFACE.test(name)) return { kind: 'virtual', label: 'Virtual network' };
  if (VPN_IFACE.test(name)) return { kind: 'vpn', label: 'VPN' };
  if (/^(wl|wlan|wifi|ath)/i.test(name)) return { kind: 'wifi', label: 'Wi-Fi' };
  if (/^(eth|enp|eno|ens|enx)/i.test(name)) return { kind: 'ethernet', label: 'Ethernet' };
  // macOS en* without a hardware port lookup: Wi-Fi on laptops, Ethernet on desktops
  if (/^en\d/i.test(name)) return { kind: 'other', label: 'Wi-Fi or Ethernet' };
  return { kind: 'other', label: 'Network' };
}

const KIND_RANK: Record<InterfaceKind, number> = { wifi: 0, ethernet: 1, other: 2, vpn: 3, virtual: 4 };

/** Home routers hand out 192.168.x, then 10.x; 172.16-31.x is mostly Docker and VM bridges. */
function addressRank(address: string): number {
  const [a, b] = address.split('.').map(Number);
  if (a === 192 && b === 168) return 0;
  if (a === 10) return 1;
  if (a === 172 && b >= 16 && b <= 31) return 2;
  return 3;
}

/**
 * Best first: the address a phone on the same Wi-Fi is most likely to reach.
 * Physical interfaces beat VPNs and VM bridges, then home-router ranges win;
 * ties keep their original order.
 */
export function rankLanInterfaces(list: LanInterface[]): LanInterface[] {
  return list
    .map((iface, i) => ({ iface, i }))
    .sort(
      (x, y) =>
        KIND_RANK[x.iface.kind] - KIND_RANK[y.iface.kind] ||
        addressRank(x.iface.address) - addressRank(y.iface.address) ||
        x.i - y.i
    )
    .map((x) => x.iface);
}

const HARDWARE_PORTS_TTL_MS = 60_000;
let hardwarePortsCache: { at: number; ports: Promise<Map<string, string>> } | null = null;

/** macOS device name -> hardware port ("en0" -> "Wi-Fi"). Empty elsewhere or on failure. */
function macHardwarePorts(): Promise<Map<string, string>> {
  if (process.platform !== 'darwin') return Promise.resolve(new Map());
  if (hardwarePortsCache && Date.now() - hardwarePortsCache.at < HARDWARE_PORTS_TTL_MS) return hardwarePortsCache.ports;
  const ports = new Promise<Map<string, string>>((resolve) => {
    execFile('networksetup', ['-listallhardwareports'], { timeout: 1500 }, (err, stdout) => {
      const map = new Map<string, string>();
      if (!err) {
        let port = '';
        for (const line of String(stdout).split('\n')) {
          const p = line.match(/^Hardware Port:\s*(.+)$/);
          if (p) port = p[1].trim();
          const d = line.match(/^Device:\s*(\S+)/);
          if (d && port) map.set(d[1], port);
        }
      }
      resolve(map);
    });
  });
  hardwarePortsCache = { at: Date.now(), ports };
  return ports;
}

/** Names and labels for the addresses the LAN listeners are bound to, best first. */
export async function describeLanAddresses(
  addresses: string[],
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()
): Promise<LanInterface[]> {
  const byAddress = new Map<string, string>();
  for (const [name, ifaces] of Object.entries(interfaces)) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !byAddress.has(iface.address)) byAddress.set(iface.address, name);
    }
  }
  const ports = addresses.length > 0 ? await macHardwarePorts() : new Map<string, string>();
  return rankLanInterfaces(
    addresses.map((address) => {
      const name = byAddress.get(address) ?? '';
      return { address, name, ...classifyInterface(name, ports.get(name)) };
    })
  );
}
