import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import { ttsProxyPlugin } from '../../server/tts-proxy.mjs';

/**
 * The demo resolves the engine and the voice package to their TypeScript
 * sources rather than built bundles, so editing either hot-reloads the page.
 * Both still build and publish as standalone packages.
 */
export default defineConfig(({ mode }) => {
  // The empty prefix loads every variable, not just VITE_ ones. That is
  // deliberate and safe here: these are read by the proxy plugin, which runs
  // in Node. Nothing without a VITE_ prefix is ever exposed to the client
  // bundle, which is exactly where the API keys need to not be.
  const env = loadEnv(mode, resolve(import.meta.dirname, '../..'), '');

  return {
    // Explicit process environment wins, so a test run or a deployment can
    // override .env without editing it.
    plugins: [ttsProxyPlugin({ env: { ...env, ...process.env } })],
    resolve: {
      alias: {
        '@deadwick/orb-engine': resolve(
          import.meta.dirname,
          '../../packages/orb-engine/src/index.ts',
        ),
        '@deadwick/voice': resolve(import.meta.dirname, '../../packages/voice/src/index.ts'),
      },
    },
    build: { target: 'es2022', sourcemap: true },
    server: { host: '127.0.0.1', port: 5173 },
    preview: { host: '127.0.0.1', port: 4173 },
  };
});
