/**
 * Generate the app icon with no image dependencies: rasterise a few geometric
 * predicates into an RGBA buffer and write a PNG by hand (zlib + CRC32).
 * A terminal prompt chevron and cursor bar on the app's own background colour.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const S = 1024;
const BG = [0x0e, 0x10, 0x13];
const FG = [0x6e, 0xa8, 0xfe];   // --accent
const GLOW = [0x2b, 0x4a, 0x7d]; // --accent-dim

const px = Buffer.alloc(S * S * 4);

const RADIUS = S * 0.22;
function insideRoundedSquare(x, y) {
  const m = S * 0.06;                     // margin
  const x0 = m, y0 = m, x1 = S - m, y1 = S - m;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + RADIUS), x1 - RADIUS);
  const cy = Math.min(Math.max(y, y0 + RADIUS), y1 - RADIUS);
  return Math.hypot(x - cx, y - cy) <= RADIUS || (x >= x0 + RADIUS && x <= x1 - RADIUS)
      || (y >= y0 + RADIUS && y <= y1 - RADIUS);
}

/** Distance from point to segment, for drawing thick strokes. */
function distToSeg(px_, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px_ - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px_ - (ax + t * dx), py - (ay + t * dy));
}

const W = S * 0.055;                       // stroke half-width
const cxm = S * 0.40, cym = S * 0.50;      // chevron centre
const arm = S * 0.15;
// '>' chevron
const chevUp = [cxm - arm * 0.8, cym - arm, cxm + arm * 0.45, cym];
const chevDn = [cxm + arm * 0.45, cym, cxm - arm * 0.8, cym + arm];
// cursor bar
const barX0 = S * 0.58, barX1 = S * 0.76, barY = cym + arm * 0.98;

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    if (!insideRoundedSquare(x, y)) { px[i + 3] = 0; continue; }
    let c = BG, a = 255;

    const d = Math.min(
      distToSeg(x, y, ...chevUp),
      distToSeg(x, y, ...chevDn),
      distToSeg(x, y, barX0, barY, barX1, barY),
    );
    if (d <= W) c = FG;
    else if (d <= W * 1.9) {
      // soft halo so the glyph does not look stamped on
      const t = 1 - (d - W) / (W * 0.9);
      c = GLOW.map((g, k) => Math.round(BG[k] + (g - BG[k]) * t * 0.9));
    }
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = a;
  }
}

// ---- minimal PNG encoder ----
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;                                   // filter: none
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync('build', { recursive: true });
writeFileSync('build/icon.png', png);
console.log(`wrote build/icon.png (${S}x${S}, ${(png.length / 1024).toFixed(0)}KB)`);
