/**
 * node-pty 1.1.0 ships broken prebuilds for Apple Silicon: prebuilds/darwin-arm64
 * contains pty.node but NO spawn-helper, and the darwin-x64 spawn-helper it does
 * ship is not marked executable. The failure mode is a bare "posix_spawnp failed."
 * at the first spawn, which looks like a permissions problem and is not.
 *
 * Rebuilding from source produces a correct arm64 spawn-helper. This runs on
 * postinstall so a fresh clone is not silently broken.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, chmodSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const ptyDir = join(root, 'node_modules', 'node-pty');
if (!existsSync(ptyDir)) process.exit(0);

// Make any shipped spawn-helper executable regardless of platform.
const prebuilds = join(ptyDir, 'prebuilds');
if (existsSync(prebuilds)) {
  for (const d of readdirSync(prebuilds)) {
    const helper = join(prebuilds, d, 'spawn-helper');
    if (existsSync(helper)) {
      try { chmodSync(helper, 0o755); } catch { /* best effort */ }
    }
  }
}

const needsRebuild =
  process.platform === 'darwin' &&
  process.arch === 'arm64' &&
  !existsSync(join(ptyDir, 'build', 'Release', 'spawn-helper'));

if (!needsRebuild) process.exit(0);

console.log('[claude-terminal] rebuilding node-pty for darwin-arm64 (missing spawn-helper prebuild)…');
try {
  execFileSync('npm', ['rebuild', 'node-pty', '--build-from-source'], {
    cwd: root,
    stdio: 'inherit',
  });
} catch {
  console.error(
    '[claude-terminal] node-pty rebuild failed. Terminals will not start.\n' +
    '  Install Xcode Command Line Tools (xcode-select --install), then run:\n' +
    '  npm rebuild node-pty --build-from-source',
  );
}
