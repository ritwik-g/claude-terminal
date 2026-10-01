/**
 * Render the CodePit icon sources in build/ into the files the packagers and
 * the web UI use:
 *
 *   build/icon.png                 1024 px, the Linux AppImage icon
 *   build/icon.icns                every macOS size, 16 to 1024 incl. @2x
 *   web/public/apple-touch-icon.png  180 px, full bleed (iOS rounds it itself)
 *   web/public/icon-192.png, icon-512.png  the same, for the web app manifest (Android)
 *
 * Every size comes from build/icon.svg. web/public/favicon.svg is the same
 * drawing cropped to the rounded square without its shadow, kept by hand.
 *
 * macOS only (iconutil). Needs rsvg-convert: `brew install librsvg`.
 * Run with `node scripts/render-icons.mjs` after editing the SVG.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const FULL = 'build/icon.svg';

function render(svg, size, out) {
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), svg, '-o', out]);
}

const work = mkdtempSync(path.join(tmpdir(), 'codepit-icons-'));
try {
  const iconset = path.join(work, 'icon.iconset');
  execFileSync('mkdir', ['-p', iconset]);
  for (const base of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = base * scale;
      const name = scale === 1 ? `icon_${base}x${base}.png` : `icon_${base}x${base}@2x.png`;
      render(FULL, px, path.join(iconset, name));
    }
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', 'build/icon.icns']);
  render(FULL, 1024, 'build/icon.png');

  // Crop to the rounded square: iOS applies its own mask, and the transparent
  // margin of the macOS grid would otherwise show as a black border.
  const bleed = path.join(work, 'bleed.svg');
  writeFileSync(bleed, readFileSync(FULL, 'utf8').replace('viewBox="0 0 1024 1024"', 'viewBox="100 100 824 824"'));
  render(bleed, 180, 'web/public/apple-touch-icon.png');
  render(bleed, 192, 'web/public/icon-192.png');
  render(bleed, 512, 'web/public/icon-512.png');

  console.log('Wrote build/icon.png, build/icon.icns and the web icons in web/public');
} finally {
  rmSync(work, { recursive: true, force: true });
}
