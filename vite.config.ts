import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const r = (p: string) => resolve(root, p);

export default defineConfig({
  plugins: [solid(), tailwind()],
  resolve: {
    alias: {
      '~': r('src'),
      '~data': r('src/data'),
      '~render': r('src/render'),
      '~state': r('src/state'),
      '~ui': r('src/ui'),
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    // A parallel project (c2pa-viewer) may hold 5173 — bind 5174 so the
    // launch.json + preview tooling can deterministically attach.
    port: 5174,
    strictPort: true,
  },
  build: {
    target: 'es2023',
    sourcemap: true,
  },
});
