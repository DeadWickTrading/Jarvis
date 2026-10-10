import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * The self-contained build: nothing external, three.js inlined.
 *
 * Resolves the engine to its source rather than its published entry so the
 * bundler can tree-shake across both packages instead of swallowing a
 * pre-built file whole.
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
      formats: ['es'],
      fileName: () => 'jarvis.standalone.js',
    },
    rollupOptions: { external: [] },
    emptyOutDir: false,
    sourcemap: false,
    target: 'es2022',
  },
});
