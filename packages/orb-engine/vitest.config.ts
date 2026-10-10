import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every test in this package is pure maths: no WebGL, no DOM, no audio
    // hardware. That is the point of keeping the numbers out of three.js.
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.ts'],
  },
});
