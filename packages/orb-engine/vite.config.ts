import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(import.meta.dirname, 'src/index.ts'),
      name: 'OrbEngine',
      formats: ['es'],
      fileName: () => 'orb-engine.js',
    },
    // three is a peer of the bundle, not inlined: a host app that already uses
    // three must not end up with two copies.
    rollupOptions: { external: ['three'] },
    sourcemap: true,
    target: 'es2022',
  },
});
