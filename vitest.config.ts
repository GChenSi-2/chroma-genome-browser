import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const r = (p: string) => resolve(root, p);

export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: {
      '~': r('src'),
      '~data': r('src/data'),
      '~render': r('src/render'),
      '~state': r('src/state'),
      '~ui': r('src/ui'),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: [
      'reference-spike/**',
      'node_modules/**',
      'tests/visual/**',
      'tests/bench/**',
      'dist/**',
    ],
    // happy-dom by default — most chroma tests touch window/document/Cache APIs.
    // Worker tests opt out per-file via `// @vitest-environment node`.
    environment: 'happy-dom',
    globals: false,
    reporters: ['default'],
    testTimeout: 10_000,
  },
});
