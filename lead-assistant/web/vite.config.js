import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The ranking and date logic is shared with the server so both agree.
      '@shared': path.resolve(here, '../shared'),
    },
  },
  define: {
    __BUILD_ID__: JSON.stringify(Date.now().toString(36)),
  },
  server: {
    port: 5173,
    fs: { allow: [path.resolve(here, '..')] },
    proxy: { '/api': { target: 'http://localhost:8080', changeOrigin: true } },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});
