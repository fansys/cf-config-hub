import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  publicDir: path.resolve(root, 'public'),
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(root, 'src'),
      '@shared': path.resolve(root, '../shared'),
    },
  },
  build: {
    outDir: path.resolve(root, '../dist/client'),
    emptyOutDir: true,
    modulePreload: { polyfill: false },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/file': 'http://127.0.0.1:8787',
      '/t': 'http://127.0.0.1:8787',
    },
  },
});
