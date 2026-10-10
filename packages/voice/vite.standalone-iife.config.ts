import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * The same self-contained bundle as vite.standalone.config.ts, but as a
 * classic IIFE rather than an ES module.
 *
 * A plain `<script src="...">` — no `type="module"` — cannot import an ES
 * module's exports; it can only read a global. This build attaches
 * everything to `window.Jarwick`, so a page that cannot or does not want to
 * add `type="module"` to its script tag still gets the whole API.
 *
 * Prefer the ES module build (jarvis.standalone.js) when the host page is
 * free to use `<script type="module">` — it does not pollute the global
 * namespace. The two are close in size once both are minified (this one is
 * marginally smaller, with no module wrapper to carry). This exists for
 * pages that cannot use a module script.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@deadwick/orb-engine': resolve(import.meta.dirname, '../orb-engine/src/index.ts'),
    },
  },
  build: {
    lib: {
      entry: resolve(import.meta.dirname, 'src/standalone.ts'),
      formats: ['iife'],
      name: 'Jarwick',
      fileName: () => 'jarwick.standalone.iife.js',
    },
    rollupOptions: { external: [] },
    emptyOutDir: false,
    sourcemap: false,
    target: 'es2022',
    minify: 'esbuild',
  },
});
