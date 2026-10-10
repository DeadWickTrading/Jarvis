import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(import.meta.dirname, 'src/index.ts'),
      name: 'JarwickVoice',
      formats: ['es'],
      fileName: () => 'voice.js',
    },
    rollupOptions: { external: ['@deadwick/orb-engine', 'three'] },
    sourcemap: true,
    target: 'es2022',
  },
});
