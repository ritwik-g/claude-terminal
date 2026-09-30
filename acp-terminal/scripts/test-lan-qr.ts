import os from 'node:os';
import QRCode from 'qrcode';

// Pure logic behind the LAN dialog's QR code: which network to offer first, and
// that the SVG path drawn in the browser is exactly the encoder's module matrix.
const { classifyInterface, rankLanInterfaces, describeLanAddresses } = await import('../server/network.js');
const { qrShape, QR_MARGIN } = await import('../web/src/qr.js');

function expect(cond: unknown, message: string): void {
  if (!cond) throw new Error(message);
}

function iface(address: string, internal = false): os.NetworkInterfaceInfo {
  return { address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: `${address}/24` };
}

/** Re-rasterises the path produced by qrShape, so it can be compared with the matrix. */
function rasterise(path: string, size: number): Uint8Array {
  const grid = new Uint8Array(size * size);
  for (const m of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)) {
    const [x, y, w, back] = m.slice(1).map(Number);
    expect(w === back, `Run at ${x},${y} must close on itself`);
    for (let i = 0; i < w; i++) grid[y * size + x + i] = 1;
  }
  return grid;
}

async function runTests() {
  console.log('🧪 [Test Suite] LAN QR code\n');

  // 1. Interface names and macOS hardware ports map to plain labels
  console.log('1️⃣ Classifying network interfaces...');
  expect(classifyInterface('en0', 'Wi-Fi').kind === 'wifi', 'macOS Wi-Fi hardware port should be Wi-Fi');
  expect(classifyInterface('en0', 'Ethernet').kind === 'ethernet', 'macOS Ethernet port should be Ethernet');
  expect(classifyInterface('en5', 'USB 10/100/1000 LAN').kind === 'ethernet', 'USB LAN adapter should be Ethernet');
  expect(classifyInterface('wlan0').kind === 'wifi' && classifyInterface('wlp2s0').kind === 'wifi', 'Linux wl* should be Wi-Fi');
  expect(classifyInterface('eth0').kind === 'ethernet' && classifyInterface('enp3s0').kind === 'ethernet', 'Linux eth*/enp* should be Ethernet');
  for (const name of ['bridge100', 'vmenet0', 'docker0', 'br-1a2b3c', 'virbr0', 'vboxnet0', 'veth12ab']) {
    expect(classifyInterface(name).kind === 'virtual', `${name} should be a virtual network`);
  }
  for (const name of ['utun3', 'tun0', 'wg0', 'tailscale0']) {
    expect(classifyInterface(name).kind === 'vpn', `${name} should be a VPN`);
  }
  expect(classifyInterface('en0').label === 'Wi-Fi or Ethernet', 'Bare macOS en* should not claim to be Wi-Fi');
  console.log('   ✅ Wi-Fi, Ethernet, virtual and VPN interfaces told apart\n');

  // 2. Best first: physical over virtual (even a 192.168 VM bridge), then home-router ranges
  console.log('2️⃣ Ranking the links...');
  const ranked = rankLanInterfaces([
    { address: '192.168.64.1', name: 'bridge100', kind: 'virtual', label: 'Virtual network' },
    { address: '172.20.0.5', name: 'eth1', kind: 'ethernet', label: 'Ethernet' },
    { address: '100.101.1.2', name: 'utun4', kind: 'vpn', label: 'VPN' },
    { address: '10.0.0.8', name: 'eth0', kind: 'ethernet', label: 'Ethernet' },
    { address: '192.168.68.104', name: 'en0', kind: 'wifi', label: 'Wi-Fi' },
  ]).map((l) => l.address);
  expect(
    JSON.stringify(ranked) === JSON.stringify(['192.168.68.104', '10.0.0.8', '172.20.0.5', '100.101.1.2', '192.168.64.1']),
    `Unexpected ranking: ${ranked.join(', ')}`
  );
  const onlyBridge = rankLanInterfaces([{ address: '172.17.0.1', name: 'docker0', kind: 'virtual', label: 'Virtual network' }]);
  expect(onlyBridge.length === 1 && onlyBridge[0].address === '172.17.0.1', 'A lone address must still be offered');
  const described = await describeLanAddresses(['192.168.64.1', '10.1.2.3', '192.168.1.7'], {
    lo0: [iface('127.0.0.1', true)],
    bridge100: [iface('192.168.64.1')],
    wlan0: [iface('192.168.1.7')],
  });
  expect(
    described.map((d) => `${d.address}/${d.name}/${d.kind}`).join(' ') ===
      '192.168.1.7/wlan0/wifi 10.1.2.3//other 192.168.64.1/bridge100/virtual',
    `describeLanAddresses: ${JSON.stringify(described)}`
  );
  console.log('   ✅ Wi-Fi first, VM bridge last, vanished addresses kept\n');

  // 3. The SVG path is the encoder's matrix, shifted by the quiet zone and nothing else
  console.log('3️⃣ Drawing the QR code...');
  const link = 'http://192.168.68.104:7812?token=0123456789abcdef0123456789abcdef0123456789abcdef';
  const { modules } = QRCode.create(link, { errorCorrectionLevel: 'M' });
  const shape = qrShape(modules);
  expect(shape.size === modules.size + QR_MARGIN * 2, 'Size must include the quiet zone on both sides');
  const grid = rasterise(shape.path, shape.size);
  for (let y = 0; y < shape.size; y++) {
    for (let x = 0; x < shape.size; x++) {
      const inside = x >= QR_MARGIN && y >= QR_MARGIN && x < QR_MARGIN + modules.size && y < QR_MARGIN + modules.size;
      const want = inside ? modules.data[(y - QR_MARGIN) * modules.size + (x - QR_MARGIN)] : 0;
      expect(grid[y * shape.size + x] === (want ? 1 : 0), `Module ${x},${y} differs from the matrix`);
    }
  }
  console.log(`   ✅ ${modules.size}x${modules.size} modules drawn exactly, ${QR_MARGIN}-module quiet zone clear\n`);

  console.log('🎉 ALL LAN QR TESTS PASSED!');
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ LAN QR test suite failed:', err);
    process.exit(1);
  });
