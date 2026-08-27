/**
 * Icon designs — Claude's mark meeting a terminal.
 *
 * Deliberately no image dependencies, matching make-icon.mjs: everything is
 * rasterised from geometric predicates and written as a PNG by hand. That is
 * also why the options you PREVIEW are pixel-identical to the one that ships —
 * there is no SVG-to-raster step in between where they could diverge.
 *
 *   node scripts/icon-designs.mjs sheet        # contact sheet of all options
 *   node scripts/icon-designs.mjs write <name> # make <name> the app icon
 *
 * Colours are sampled from the real Claude Code and terminal icons rather than
 * guessed: the Claude tile is a vertical gradient, not a flat fill.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

// ---------------------------------------------------------------- palette
export const C = {
  orangeTop: [0xe8, 0x71, 0x4f],
  orangeBot: [0xec, 0x5f, 0x36],
  white: [0xff, 0xff, 0xff],
  dark: [0x0e, 0x10, 0x13],
  darkRaised: [0x18, 0x1a, 0x1f],
  blue: [0x6e, 0xa8, 0xfe],
  blueDim: [0x2b, 0x4a, 0x7d],
  screen: [0x16, 0x19, 0x1e],
  titleBar: [0x24, 0x28, 0x31],
};

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// ---------------------------------------------------------------- geometry

/**
 * macOS icon silhouette. A superellipse, not a rounded rectangle — the corner
 * of a rounded rect meets its edge at a visible curvature break, which is
 * exactly what makes a hand-made icon sit wrong next to system ones.
 */
function inTile(x, y, S, inset = 0.055) {
  const a = S * (0.5 - inset);
  const cx = S / 2;
  const n = 4.6;
  return Math.abs((x - cx) / a) ** n + Math.abs((y - cx) / a) ** n <= 1;
}

/** Distance from a point to a segment — round caps come free. */
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Claude's sunburst: constant-width rays with round caps, radiating from a
 * hub the overlapping ray roots create on their own. The lengths repeat over a
 * short irregular cycle — evenly-sized rays read as a machine-drawn asterisk,
 * and the varying ones are what make it Claude's mark.
 */
const RAY_LENGTHS = [1, 0.74, 0.95, 0.7, 1, 0.78, 0.93, 0.72, 1, 0.76, 0.9, 0.68];

/**
 * Ray half-width as a fraction of ray length. Measured off the real mark,
 * which runs about 12:1 — the single number that decides whether this reads as
 * a sunburst or as a spiky blob. Deriving it from R rather than fixing it in
 * pixels keeps every size of burst in proportion.
 */
const RAY_ASPECT = 0.085;

export function burstDist(x, y, cx, cy, R, rotate = -Math.PI / 2) {
  const n = RAY_LENGTHS.length;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const a = rotate + (i / n) * Math.PI * 2;
    const L = R * RAY_LENGTHS[i];
    const d = distToSeg(x, y, cx, cy, cx + Math.cos(a) * L, cy + Math.sin(a) * L);
    if (d < best) best = d;
  }
  return best;
}

/** True inside the burst of radius R centred at (cx, cy). */
const inBurst = (x, y, cx, cy, R, rotate) =>
  burstDist(x, y, cx, cy, R, rotate) <= R * RAY_ASPECT;

/** A '>' chevron and its cursor bar, as a distance field. */
function promptDist(x, y, S, cx, cy, scale, withBar = true) {
  const arm = S * 0.15 * scale;
  const d1 = distToSeg(x, y, cx - arm * 0.8, cy - arm, cx + arm * 0.45, cy);
  const d2 = distToSeg(x, y, cx + arm * 0.45, cy, cx - arm * 0.8, cy + arm);
  if (!withBar) return Math.min(d1, d2);
  const barY = cy + arm * 0.98;
  const d3 = distToSeg(x, y, cx + arm * 0.9, barY, cx + arm * 2.15, barY);
  return Math.min(d1, d2, d3);
}

// ---------------------------------------------------------------- designs
// Each returns [r, g, b, a] for one sample, or null for "outside the icon".

const orangeAt = (y, S) => mix(C.orangeTop, C.orangeBot, y / S);

export const DESIGNS = {
  /**
   * The Claude mark standing where the prompt character goes, with the cursor
   * bar under it. Reads as a terminal at a glance; the mark says whose.
   */
  prompt(x, y, S) {
    if (!inTile(x, y, S)) return null;
    if (inBurst(x, y, S * 0.415, S * 0.425, S * 0.255)) return [...orangeAt(y, S), 255];
    // The cursor sits on the burst's baseline and to its right, where the '_'
    // of a '>_' prompt would be — anywhere else and it reads as a stray dash.
    const barY = S * 0.665;
    if (distToSeg(x, y, S * 0.575, barY, S * 0.80, barY) <= S * 0.043) return [...C.blue, 255];
    return [...C.dark, 255];
  },

  /**
   * The chosen icon: the terminal prompt in white on Claude's orange tile.
   *
   * White rather than the dark knockout it started as, so it follows Claude's
   * own convention — its marks are white on orange, never a hole punched
   * through to the background. White on this orange is the weaker contrast of
   * the two, so the stroke is a little heavier than the dark version needed.
   */
  knockout(x, y, S) {
    if (!inTile(x, y, S)) return null;
    // Centres of the glyph's BOUNDING BOX, not of its chevron: the cursor bar
    // extends the mark to the right, so centring the chevron leaves the whole
    // thing sitting left and high in the tile. Measured, not guessed.
    const d = promptDist(x, y, S, S * 0.394, S * 0.502, 1.05);
    if (d <= S * 0.056) return [...C.white, 255];
    return [...orangeAt(y, S), 255];
  },

  /**
   * The burst as the cursor block: you type at a blue prompt and what answers
   * is Claude. The only option where the two marks sit side by side rather
   * than one inside the other.
   */
  cursor(x, y, S) {
    if (!inTile(x, y, S)) return null;
    if (promptDist(x, y, S, S * 0.285, S * 0.5, 0.95, false) <= S * 0.045) return [...C.blue, 255];
    if (inBurst(x, y, S * 0.635, S * 0.5, S * 0.215)) return [...orangeAt(y, S), 255];
    return [...C.dark, 255];
  },

  /**
   * The terminal glyph at full size, badged with Claude Code's own tile. The
   * most legible when small, because neither mark has to shrink to share the
   * space — the badge simply overlaps, the way a status badge does.
   */
  badge(x, y, S) {
    if (!inTile(x, y, S)) return null;
    const bx = S * 0.715, by = S * 0.715, bR = S * 0.225;
    // A dark moat first, so the badge stays a separate object against the
    // glyph rather than merging with whatever it happens to overlap.
    const inMoat = Math.abs((x - bx) / (bR * 1.2)) ** 4.6 + Math.abs((y - by) / (bR * 1.2)) ** 4.6 <= 1;
    const inBadge = Math.abs((x - bx) / bR) ** 4.6 + Math.abs((y - by) / bR) ** 4.6 <= 1;
    if (inBadge) {
      if (inBurst(x, y, bx, by, bR * 0.66)) return [...C.white, 255];
      return [...orangeAt(y, S), 255];
    }
    if (inMoat) return [...C.dark, 255];
    if (promptDist(x, y, S, S * 0.38, S * 0.44, 1.0) <= S * 0.05) return [...C.blue, 255];
    return [...C.dark, 255];
  },

  /**
   * A terminal window with the burst inside it. The most literal reading —
   * "Claude, in a window" — and the one with the most detail to lose when the
   * icon gets small.
   */
  window(x, y, S) {
    if (!inTile(x, y, S)) return null;
    // The window needs its own fill: drawn as an outline on a tile of the same
    // colour it simply disappears, which is what the first pass did.
    const x0 = S * 0.145, x1 = S * 0.855, y0 = S * 0.165, y1 = S * 0.835;
    const r = S * 0.055;
    const inWin =
      x >= x0 && x <= x1 && y >= y0 && y <= y1 &&
      Math.hypot(
        x - Math.min(Math.max(x, x0 + r), x1 - r),
        y - Math.min(Math.max(y, y0 + r), y1 - r),
      ) <= r;
    if (!inWin) return [...C.dark, 255];

    const barH = S * 0.14;
    if (y < y0 + barH) {
      for (let i = 0; i < 3; i++) {
        const cx = x0 + S * 0.055 + i * S * 0.062;
        if (Math.hypot(x - cx, y - (y0 + barH / 2)) <= S * 0.021) {
          return [...(i === 0 ? C.orangeTop : C.blueDim), 255];
        }
      }
      return [...C.titleBar, 255];
    }
    if (inBurst(x, y, S * 0.5, S * 0.585, S * 0.20)) return [...orangeAt(y, S), 255];
    return [...C.screen, 255];
  },
};

// ---------------------------------------------------------------- raster

/**
 * Supersample every pixel. The shapes are hard predicates, so without this
 * every ray tip and every corner of the tile is a staircase — most visible at
 * exactly the sizes an icon is actually seen at.
 */
export function render(design, S, ss = 4) {
  const fn = DESIGNS[design];
  if (!fn) throw new Error(`unknown design: ${design}`);
  const px = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const s = fn(x + (sx + 0.5) / ss, y + (sy + 0.5) / ss, S);
          if (!s) continue;
          r += s[0]; g += s[1]; b += s[2]; a += s[3];
        }
      }
      const n = ss * ss;
      const i = (y * S + x) * 4;
      const cov = a / (255 * n);
      // Premultiplied average, then un-premultiply: averaging colour over
      // samples that include fully transparent ones would darken every edge
      // towards black.
      if (cov > 0) {
        px[i] = Math.round(r / (n * cov));
        px[i + 1] = Math.round(g / (n * cov));
        px[i + 2] = Math.round(b / (n * cov));
      }
      px[i + 3] = Math.round(cov * 255);
    }
  }
  return px;
}

// ---------------------------------------------------------------- png
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

export function encodePng(w, h, rgba) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- cli
const NAMES = Object.keys(DESIGNS);

function blit(dst, dw, src, sw, sh, ox, oy) {
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const s = (y * sw + x) * 4;
      const alpha = src[s + 3] / 255;
      if (alpha === 0) continue;
      const d = ((oy + y) * dw + ox + x) * 4;
      for (let k = 0; k < 3; k++) dst[d + k] = Math.round(dst[d + k] * (1 - alpha) + src[s + k] * alpha);
      dst[d + 3] = 255;
    }
  }
}

/**
 * Every option at the two sizes that matter: big enough to judge, and 32px,
 * where an icon actually lives in a Dock or a tab strip. A design that only
 * works at 512 is not a design.
 */
function sheet() {
  const BIG = 160, SMALL = 32, PAD = 22, LABEL = 34;
  const W = PAD + NAMES.length * (BIG + PAD);
  const H = PAD + BIG + 16 + SMALL + LABEL;
  const canvas = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    canvas[i * 4] = 0x17; canvas[i * 4 + 1] = 0x19; canvas[i * 4 + 2] = 0x1c; canvas[i * 4 + 3] = 255;
  }
  NAMES.forEach((name, i) => {
    const ox = PAD + i * (BIG + PAD);
    blit(canvas, W, render(name, BIG, 4), BIG, BIG, ox, PAD);
    blit(canvas, W, render(name, SMALL, 6), SMALL, SMALL, ox + (BIG - SMALL) / 2, PAD + BIG + 16);
  });
  mkdirSync('build', { recursive: true });
  writeFileSync('build/icon-options.png', encodePng(W, H, canvas));
  console.log(`wrote build/icon-options.png — ${NAMES.join(', ')}`);
}

const [, , cmd, arg] = process.argv;
if (cmd === 'sheet') sheet();
else if (cmd === 'write') {
  if (!NAMES.includes(arg)) {
    console.error(`usage: node scripts/icon-designs.mjs write <${NAMES.join('|')}>`);
    process.exit(1);
  }
  mkdirSync('build', { recursive: true });
  writeFileSync('build/icon.png', encodePng(1024, 1024, render(arg, 1024, 3)));
  console.log(`wrote build/icon.png from design "${arg}"`);
} else if (cmd === 'one') {
  const size = Number(process.env.SIZE || 256);
  writeFileSync(`build/icon-${arg}.png`, encodePng(size, size, render(arg, size, 4)));
  console.log(`wrote build/icon-${arg}.png`);
}
