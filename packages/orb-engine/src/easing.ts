/**
 * Frame-rate independent easing.
 *
 * Every animated parameter moves a fraction of its remaining distance toward
 * its target each frame. Doing that naively (`v += (target - v) * 0.1`) makes
 * the motion depend on frame rate: a 120fps monitor takes twice as many steps
 * per second as a 60fps one and arrives twice as fast.
 *
 * The fix is to treat the per-frame fraction as a continuous decay rate and
 * integrate it over the elapsed time, which is exact for any step size:
 *
 *     v(t) = target + (v0 - target) * exp(-rate * t)
 *
 * Because `exp(-r*a) * exp(-r*b) === exp(-r*(a+b))`, sixty steps of 1/60s and
 * thirty steps of 2/60s land in precisely the same place. `test/easing.test.ts`
 * asserts exactly that.
 */

/**
 * Move `current` toward `target`, covering a share of the remaining distance
 * determined by `rate` (per second) and `dt` (seconds).
 *
 * @param rate Decay rate in reciprocal seconds. Higher is snappier. Zero holds.
 */
export function approach(current: number, target: number, rate: number, dt: number): number {
  if (!(dt > 0) || rate <= 0) return current;
  return target + (current - target) * Math.exp(-rate * dt);
}

/**
 * Convert the designer-friendly "cover this fraction of the gap each frame at
 * 60fps" into the decay rate `approach` wants.
 *
 * `rateFromPerFrame(0.1)` is the rate at which a naive `v += gap * 0.1` loop
 * running at exactly 60fps would converge — but now correct at any frame rate.
 */
export function rateFromPerFrame(fraction: number, referenceFps = 60): number {
  const f = Math.min(0.999999, Math.max(0, fraction));
  if (f === 0) return 0;
  return -Math.log(1 - f) * referenceFps;
}

/** Convert a half-life in seconds to a decay rate. */
export function rateFromHalfLife(halfLifeSeconds: number): number {
  if (halfLifeSeconds <= 0) return Number.POSITIVE_INFINITY;
  return Math.LN2 / halfLifeSeconds;
}

/**
 * Asymmetric follower: rises toward a rising target quickly and falls slowly.
 * This is what keeps an audio-driven value breathing rather than twitching.
 *
 * @param attackRate Decay rate used when `target > current`.
 * @param decayRate  Decay rate used when `target <= current`.
 */
export function approachAsymmetric(
  current: number,
  target: number,
  attackRate: number,
  decayRate: number,
  dt: number,
): number {
  return approach(current, target, target > current ? attackRate : decayRate, dt);
}

/** Clamp `v` into `[min, max]`. */
export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** Clamp `v` into `[0, 1]`. */
export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/** Linear interpolation; `t` is not clamped. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Hermite smoothstep between two edges. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
