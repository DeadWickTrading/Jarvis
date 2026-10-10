import { describe, expect, it } from 'vitest';
import {
  approach,
  approachAsymmetric,
  clamp,
  clamp01,
  lerp,
  rateFromHalfLife,
  rateFromPerFrame,
  smoothstep,
} from '../src/easing.js';

describe('approach', () => {
  /**
   * The headline property. If this fails, the orb eases at a different speed
   * on a 120Hz monitor than on a 30fps laptop, which is the whole reason the
   * easing is written as a decay rate rather than a per-frame fraction.
   */
  it('lands in the same place regardless of how the time is divided', () => {
    const rate = rateFromPerFrame(0.1);

    let sixtySteps = 0;
    for (let i = 0; i < 60; i += 1) sixtySteps = approach(sixtySteps, 1, rate, 1 / 60);

    let thirtySteps = 0;
    for (let i = 0; i < 30; i += 1) thirtySteps = approach(thirtySteps, 1, rate, 2 / 60);

    let oneStep = approach(0, 1, rate, 1);

    expect(sixtySteps).toBeCloseTo(thirtySteps, 12);
    expect(sixtySteps).toBeCloseTo(oneStep, 12);
  });

  it('holds still across a wide range of step sizes', () => {
    const rate = rateFromPerFrame(0.06);
    const after = (steps: number) => {
      let v = 0;
      for (let i = 0; i < steps; i += 1) v = approach(v, 10, rate, 2 / steps);
      return v;
    };
    const reference = after(120);
    for (const steps of [1, 2, 7, 15, 48, 240, 1000]) {
      expect(after(steps)).toBeCloseTo(reference, 9);
    }
  });

  it('moves toward the target without overshooting, from either side', () => {
    const rate = rateFromPerFrame(0.5);
    const up = approach(0, 1, rate, 1 / 60);
    expect(up).toBeGreaterThan(0);
    expect(up).toBeLessThan(1);

    const down = approach(5, 1, rate, 1 / 60);
    expect(down).toBeGreaterThan(1);
    expect(down).toBeLessThan(5);
  });

  it('converges on the target given enough time', () => {
    expect(approach(0, 1, rateFromPerFrame(0.06), 30)).toBeCloseTo(1, 6);
  });

  it('is a no-op for a zero rate, a zero step or a backwards step', () => {
    expect(approach(0.5, 1, 0, 1)).toBe(0.5);
    expect(approach(0.5, 1, 10, 0)).toBe(0.5);
    expect(approach(0.5, 1, 10, -1)).toBe(0.5);
  });
});

describe('rateFromPerFrame', () => {
  it('reproduces the naive per-frame fraction at the reference frame rate', () => {
    // A naive `v += gap * 0.1` loop at 60fps, versus one corrected step of the
    // same duration: the whole point is that these agree at 60fps.
    let naive = 0;
    for (let i = 0; i < 60; i += 1) naive += (1 - naive) * 0.1;
    const corrected = approach(0, 1, rateFromPerFrame(0.1), 1);
    expect(corrected).toBeCloseTo(naive, 9);
  });

  it('clamps degenerate fractions instead of producing infinities', () => {
    expect(rateFromPerFrame(0)).toBe(0);
    expect(rateFromPerFrame(-1)).toBe(0);
    expect(Number.isFinite(rateFromPerFrame(1))).toBe(true);
  });
});

describe('rateFromHalfLife', () => {
  it('covers exactly half the distance in one half-life', () => {
    expect(approach(0, 1, rateFromHalfLife(0.5), 0.5)).toBeCloseTo(0.5, 12);
    expect(approach(0, 1, rateFromHalfLife(0.5), 1)).toBeCloseTo(0.75, 12);
  });
});

describe('approachAsymmetric', () => {
  const attack = rateFromPerFrame(0.45);
  const decay = rateFromPerFrame(0.08);

  it('rises much faster than it falls', () => {
    const rise = approachAsymmetric(0, 1, attack, decay, 1 / 60);
    const fall = 1 - approachAsymmetric(1, 0, attack, decay, 1 / 60);
    expect(rise).toBeGreaterThan(fall * 4);
  });

  it('stays frame-rate independent in both directions', () => {
    const run = (steps: number, from: number, to: number) => {
      let v = from;
      for (let i = 0; i < steps; i += 1) v = approachAsymmetric(v, to, attack, decay, 1 / steps);
      return v;
    };
    expect(run(60, 0, 1)).toBeCloseTo(run(30, 0, 1), 9);
    expect(run(60, 1, 0)).toBeCloseTo(run(30, 1, 0), 9);
  });
});

describe('helpers', () => {
  it('clamps', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
    expect(clamp01(2)).toBe(1);
  });

  it('interpolates', () => {
    expect(lerp(0, 10, 0.25)).toBe(2.5);
  });

  it('smoothsteps with zero slope at both edges', () => {
    expect(smoothstep(0, 1, 0)).toBe(0);
    expect(smoothstep(0, 1, 1)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 12);
    expect(smoothstep(0, 1, -3)).toBe(0);
    expect(smoothstep(0, 1, 3)).toBe(1);
    // Degenerate edges must not divide by zero.
    expect(smoothstep(1, 1, 0.5)).toBe(0);
    expect(smoothstep(1, 1, 2)).toBe(1);
  });
});
