import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * The demo resolves the engine to its TypeScript source rather than its built
 * bundle, so editing the engine hot-reloads the page. The engine still builds
 * and publishes as a standalone package; nothing here is required to use it.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@deadwick/orb-engine': resolve(import.meta.dirname, '../../packages/orb-engine/src/index.ts'),
    },
  },
  build: { target: 'es2022', sourcemap: true },
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1', port: 4173 },
});
