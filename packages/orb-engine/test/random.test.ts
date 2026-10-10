import { describe, expect, it } from 'vitest';
import { createRng } from '../src/random.js';

describe('createRng', () => {
  it('is deterministic for a seed', () => {
    const draw = (seed: number, n: number) => {
      const rng = createRng(seed);
      return Array.from({ length: n }, () => rng.next());
    };
    // Two generators on the same seed must agree for the whole sequence, not
    // just the first draw: the galaxy layout depends on hundreds of values.
    expect(draw(1234, 500)).toEqual(draw(1234, 500));
    expect(draw(0, 20)).toEqual(draw(0, 20));
  });

  it('gives different sequences for different seeds', () => {
    const a = Array.from({ length: 50 }, () => createRng(1).next());
    const b = Array.from({ length: 50 }, () => createRng(2).next());
    expect(a).not.toEqual(b);
  });

  it('stays inside [0, 1)', () => {
    const rng = createRng(7);
    for (let i = 0; i < 10_000; i += 1) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('is roughly uniform', () => {
    const rng = createRng(42);
    const buckets = new Array<number>(10).fill(0);
    const n = 100_000;
    for (let i = 0; i < n; i += 1) buckets[Math.floor(rng.next() * 10)]! += 1;
    for (const count of buckets) {
      expect(Math.abs(count - n / 10) / (n / 10)).toBeLessThan(0.05);
    }
  });

  it('respects range and int bounds', () => {
    const rng = createRng(3);
    for (let i = 0; i < 2000; i += 1) {
      const v = rng.range(-5, 5);
      expect(v).toBeGreaterThanOrEqual(-5);
      expect(v).toBeLessThan(5);

      const n = rng.int(2, 6);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(6);
    }
  });

  it('scatters points evenly over the sphere rather than bunching at the poles', () => {
    const rng = createRng(11);
    let polar = 0;
    const n = 20_000;
    for (let i = 0; i < n; i += 1) {
      const [x, y, z] = rng.onSphere();
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 10);
      // A correct distribution puts half its points in |z| > 0.5.
      if (Math.abs(z) > 0.5) polar += 1;
    }
    expect(Math.abs(polar / n - 0.5)).toBeLessThan(0.02);
  });
});
