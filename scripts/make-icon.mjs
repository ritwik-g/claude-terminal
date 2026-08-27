/**
 * Build the app icon and the DMG background.  npm run icon
 *
 * The artwork lives in icon-designs.mjs, which holds every option that was
 * considered; this file only says which one ships and packages it into the
 * formats electron-builder wants. Keeping those together is what stops
 * `npm run icon` from quietly regenerating an older design over the current
 * one — the failure mode of letting the icon exist only as a committed PNG.
 *
 * Still no image dependencies: everything is rasterised from geometric
 * predicates and written as a PNG by hand.
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { render, encodePng } from './icon-designs.mjs';

/** The chosen design: the terminal prompt in white on Claude's orange tile. */
const DESIGN = 'knockout';

mkdirSync('build', { recursive: true });

// ---- build/icon.png — used directly for Linux, and as the master ----
const MASTER = 1024;
writeFileSync('build/icon.png', encodePng(MASTER, MASTER, render(DESIGN, MASTER, 3)));
console.log(`wrote build/icon.png (${MASTER}x${MASTER}, design "${DESIGN}")`);

// ---- build/icon.icns ----
/**
 * Every size is RENDERED at its own resolution rather than downscaled from the
 * master. The stroke is a fraction of the icon size, so rendering at 16px
 * gives a crisp two-pixel stroke where downscaling the 1024 gives a grey
 * smear — and 16px is the size Finder's list view actually uses.
 *
 * macOS only: iconutil ships with Xcode's command line tools and exists
 * nowhere else. build/icon.icns is committed, so a contributor on Linux keeps
 * the checked-in one rather than being blocked by this step.
 */
const ICNS_SIZES = [
  [16, 'icon_16x16.png'],
  [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'],
  [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'],
  [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png'],
];

if (process.platform === 'darwin') {
  const dir = 'build/icon.iconset';
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const cache = new Map();
  for (const [size, name] of ICNS_SIZES) {
    if (!cache.has(size)) {
      // Small icons need MORE samples per pixel, not fewer: at 16px one pixel
      // covers a large slice of the glyph's edge.
      const ss = size <= 64 ? 8 : size <= 256 ? 4 : 3;
      cache.set(size, encodePng(size, size, render(DESIGN, size, ss)));
    }
    writeFileSync(`${dir}/${name}`, cache.get(size));
  }
  execFileSync('iconutil', ['-c', 'icns', dir, '-o', 'build/icon.icns']);
  rmSync(dir, { recursive: true, force: true });
  console.log(`wrote build/icon.icns (${ICNS_SIZES.length} representations)`);
} else {
  console.log('skipped build/icon.icns — iconutil is macOS only; keeping the committed one');
}

// ---- build/background.png ----
/**
 * The DMG background.
 *
 * Not decoration — it is load-bearing. With a custom `contents` layout,
 * dmgbuild installs a background into the mounted volume, and on GitHub's
 * macOS runners it dies with
 *   FileNotFoundError: /Volumes/.../.background/background.tiff
 * when electron-builder has to supply its own. Giving it a real file at
 * build/background.png (which electron-builder picks up by convention) is what
 * makes the DMG build reproducible in CI.
 */
const BW = 660, BH = 400;
const bg = Buffer.alloc(BW * BH * 4);
for (let y = 0; y < BH; y++) {
  for (let x = 0; x < BW; x++) {
    const i = (y * BW + x) * 4;
    // Gentle vertical gradient in the app's own background colours.
    const t = y / BH;
    bg[i] = Math.round(0x0e + (0x16 - 0x0e) * t);
    bg[i + 1] = Math.round(0x10 + (0x1a - 0x10) * t);
    bg[i + 2] = Math.round(0x13 + (0x21 - 0x13) * t);
    bg[i + 3] = 255;
  }
}
writeFileSync('build/background.png', encodePng(BW, BH, bg));
console.log(`wrote build/background.png (${BW}x${BH})`);
