/**
 * A seeded pseudo-random generator.
 *
 * The galaxy layout must be identical for the same seed so that screenshots
 * and visual tests are reproducible, and so the thinned performance-mode
 * layout is recognisably the same galaxy with fewer points rather than a
 * different one. `Math.random` cannot do that, so we carry our own.
 *
 * mulberry32: 32-bit state, good distribution for this purpose, four lines.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** Integer in [min, max]. */
  int(min: number, max: number): number;
  /** A point uniformly distributed on the unit sphere. */
  onSphere(): [number, number, number];
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const range = (min: number, max: number): number => min + next() * (max - min);
  return {
    next,
    range,
    int: (min, max) => Math.floor(range(min, max + 1)),
    /**
     * Marsaglia's method: pick z uniformly and the azimuth uniformly. Picking
     * the polar angle uniformly instead would bunch points at the poles.
     */
    onSphere: () => {
      const z = range(-1, 1);
      const theta = range(0, Math.PI * 2);
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      return [r * Math.cos(theta), r * Math.sin(theta), z];
    },
  };
}
