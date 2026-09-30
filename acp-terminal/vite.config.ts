import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = 'http://127.0.0.1:7890';
// The server's app dir: CODEPIT_APP_DIR (or the older ACP_APP_DIR), else ~/.codepit
const APP_DIR = process.env.CODEPIT_APP_DIR || process.env.ACP_APP_DIR || path.join(os.homedir(), '.codepit');
const TOKEN_FILE = path.join(APP_DIR, 'token');

function token(): string {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5280,
    strictPort: true,
    proxy: {
      '/api': {
        target: API,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            const t = token();
            if (t) proxyReq.setHeader('x-codepit-token', t);
          });
        },
      },
      '/ws': {
        target: API,
        ws: true,
        configure: (proxy) => {
          proxy.on('proxyReqWs', (proxyReq) => {
            const t = token();
            if (t) proxyReq.setHeader('x-codepit-token', t);
          });
        },
      },
    },
  },
});
