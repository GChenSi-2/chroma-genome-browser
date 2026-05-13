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
    port: 5173,
    strictPort: false,
  },
  build: {
    target: 'es2023',
    sourcemap: true,
  },
});
