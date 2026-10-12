import { defineConfig } from 'vite';

// base './' makes the built site work from any sub-path (GitHub Pages serves it under /solarsystemmodel/).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
