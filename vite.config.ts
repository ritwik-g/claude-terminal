import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = 'http://127.0.0.1:7777';

/**
 * In dev the page is served by Vite and the API by our own server, so the token
 * never reaches the browser the way it does in the packaged app (where the
 * launcher puts it in the URL). Vite runs in Node, though, and the server drops
 * the token in a 0600 file — so the proxy attaches it on the way through and
 * dev needs no special case on the server side.
 *
 * Read per request rather than cached: `tsx watch` restarts the server on every
 * edit and each start mints a new token.
 */
const TOKEN_FILE = path.join(os.homedir(), '.claude-terminal', 'token');

function token(): string {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    // Server not started yet — the request will 401 and the client retries.
    return '';
  }
}

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      '/api': {
        target: API,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            const t = token();
            if (t) proxyReq.setHeader('x-ct-token', t);
          });
        },
      },
      '/ws': {
        target: API,
        ws: true,
        configure: (proxy) => {
          proxy.on('proxyReqWs', (proxyReq) => {
            const t = token();
            if (t) proxyReq.setHeader('x-ct-token', t);
          });
        },
      },
    },
  },
});
