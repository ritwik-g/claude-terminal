import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = 'http://127.0.0.1:7777';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/ws': { target: API, ws: true },
    },
  },
});
