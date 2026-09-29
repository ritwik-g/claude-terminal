import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = 'http://127.0.0.1:7890';
const TOKEN_FILE = path.join(os.homedir(), '.acp-terminal', 'token');

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
            if (t) proxyReq.setHeader('x-acp-token', t);
          });
        },
      },
      '/ws': {
        target: API,
        ws: true,
        configure: (proxy) => {
          proxy.on('proxyReqWs', (proxyReq) => {
            const t = token();
            if (t) proxyReq.setHeader('x-acp-token', t);
          });
        },
      },
    },
  },
});
