import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import { hqBridgePlugin } from '../../server/hq-bridge.mjs';
import { optionsBridgePlugin } from '../../server/options-bridge.mjs';
import { ttsProxyPlugin } from '../../server/speech-proxy.mjs';
import { JARWICK_AGENT_SETTINGS } from './src/agent-settings.ts';

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
    plugins: [
      ttsProxyPlugin({ env: { ...env, ...process.env } }),
      // HQ at /hq/ and a snapshot of it for the agent (HQ_DIR overrides the folder).
      hqBridgePlugin({ settings: JARWICK_AGENT_SETTINGS, hqDir: env.HQ_DIR || process.env.HQ_DIR }),
      // Options HQ at /options/ with its own snapshot and tools under /opt/api/hq/ (OPTIONS_HQ_DIR overrides the folder).
      optionsBridgePlugin({ settings: JARWICK_AGENT_SETTINGS, dir: env.OPTIONS_HQ_DIR || process.env.OPTIONS_HQ_DIR }),
    ],
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
