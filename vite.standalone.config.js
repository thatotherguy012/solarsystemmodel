import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Standalone build: one self-contained HTML file (all JS, CSS and bundled data inlined) that runs by
// double-clicking it from disk (file://), with no server. Output: standalone/SolarSystem.html.
// The normal `npm run build` (vite.config.js -> dist/, used by GitHub Pages) is unaffected.
const OUT_DIR = 'standalone';
const OUT_FILE = 'SolarSystem.html';

export default defineConfig({
  base: './',
  publicDir: false,
  build: {
    target: 'es2022',
    outDir: OUT_DIR,
    emptyOutDir: true,
    // Everything is inlined, so the modulepreload polyfill (which fetch()es preload links) is dead code.
    modulePreload: { polyfill: false },
  },
  plugins: [
    viteSingleFile(),
    {
      // The single-file plugin writes index.html; give it a friendlier name.
      name: 'standalone:rename-html',
      apply: 'build',
      enforce: 'post',
      writeBundle(options) {
        const dir = options.dir || OUT_DIR;
        renameSync(join(dir, 'index.html'), join(dir, OUT_FILE));
      },
    },
  ],
});
