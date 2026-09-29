import os from 'node:os';

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
