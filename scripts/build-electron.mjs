/**
 * Bundle the Electron main process (and the server it hosts) into a single
 * ESM file.
 *
 * ESM rather than CJS because server/index.ts uses `import.meta.url`; Electron
 * 33 runs an ESM main process natively, so this avoids shimming it.
 *
 * `electron` and `node-pty` stay EXTERNAL: electron is provided by the runtime,
 * and node-pty is a native module that must remain a real file on disk
 * (unpacked from the asar) for its spawn-helper to be executable.
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

rmSync('dist-electron', { recursive: true, force: true });

await build({
  entryPoints: ['electron/main.ts'],
  outfile: 'dist-electron/main.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  external: ['electron', 'node-pty'],
  banner: {
    // express and ws pull in CJS deps that expect these to exist.
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join('\n'),
  },
  logLevel: 'info',
});
