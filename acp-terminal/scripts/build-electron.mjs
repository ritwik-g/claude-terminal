/**
 * Bundle the CodePit desktop app's main process (and the server it hosts) into
 * dist-electron/main.mjs, and the agent scripts it launches into
 * dist-electron/agents/.
 *
 * `electron` and `node-pty` stay EXTERNAL: electron is provided by the runtime,
 * and node-pty is a native module that must remain a real file on disk
 * (unpacked from the asar) for its spawn-helper to be executable.
 *
 * The agent scripts are bundled whole so a packaged app needs no tsx to run
 * them. They run as separate processes on Electron in Node mode, from real
 * files unpacked next to app.asar.
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

rmSync('dist-electron', { recursive: true, force: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: {
    // express, ws and the ACP SDK pull in CJS deps that expect these to exist.
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join('\n'),
  },
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: ['electron/main.ts'],
  outfile: 'dist-electron/main.mjs',
  sourcemap: true,
  external: ['electron', 'node-pty'],
});

await build({
  ...common,
  entryPoints: {
    'agent-launcher': 'server/agents/agent-launcher.ts',
    'antigravity-agent': 'server/agents/antigravity-agent.ts',
    'mock-agent': 'server/agents/mock-agent.ts',
  },
  outdir: 'dist-electron/agents',
  outExtension: { '.js': '.mjs' },
});
