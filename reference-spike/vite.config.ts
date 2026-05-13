import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    open: '/index.html',
  },
  build: {
    target: 'esnext',
    sourcemap: true,
  },
});
