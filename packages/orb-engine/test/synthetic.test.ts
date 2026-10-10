import { describe, expect, it } from 'vitest';
import { syntheticLevels } from '../src/audio/synthetic.js';

const sample = (seconds: number, step = 1 / 60, seed = 1) =>
  Array.from({ length: Math.round(seconds / step) }, (_, i) => syntheticLevels(i * step, seed));

describe('syntheticLevels', () => {
  it('is a pure function of time, so screenshots stay comparable', () => {
    for (const t of [0, 0.37, 1, 4.25, 17.9]) {
      expect(syntheticLevels(t)).toEqual(syntheticLevels(t));
    }
    expect(sample(5)).toEqual(sample(5));
  });

  it('keeps every component in 0..1', () => {
    for (const { level, bass, treble } of sample(60)) {
      for (const v of [level, bass, treble]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('looks like speech: syllabic peaks with real pauses between phrases', () => {
    const levels = sample(60).map((l) => l.level);
    expect(Math.max(...levels)).toBeGreaterThan(0.6);
    // The phrase envelope genuinely closes, rather than idling at a hum.
    expect(Math.min(...levels)).toBeLessThan(0.02);

    // Syllables at roughly three a second: count upward zero crossings of the
    // level through a mid threshold over a minute.
    let onsets = 0;
    for (let i = 1; i < levels.length; i += 1) {
      if (levels[i - 1]! <= 0.25 && levels[i]! > 0.25) onsets += 1;
    }
    const perSecond = onsets / 60;
    expect(perSecond).toBeGreaterThan(1);
    expect(perSecond).toBeLessThan(4);
  });

  it('spends a meaningful share of the time quiet', () => {
    const levels = sample(120).map((l) => l.level);
    const quiet = levels.filter((v) => v < 0.1).length / levels.length;
    expect(quiet).toBeGreaterThan(0.1);
    expect(quiet).toBeLessThan(0.75);
  });

  it('keeps treble spikier than bass, as a voice does', () => {
    const data = sample(60);
    const spread = (pick: (l: (typeof data)[number]) => number) => {
      const values = data.map(pick);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length) / (mean || 1);
    };
    expect(spread((l) => l.treble)).toBeGreaterThan(spread((l) => l.bass));
  });

  it('shifts phase with the seed without changing its character', () => {
    const a = sample(20, 1 / 60, 1).map((l) => l.level);
    const b = sample(20, 1 / 60, 5).map((l) => l.level);
    expect(a).not.toEqual(b);

    const mean = (xs: number[]) => xs.reduce((p, q) => p + q, 0) / xs.length;
    // Same kind of signal, just not in step.
    expect(Math.abs(mean(a) - mean(b))).toBeLessThan(0.2);
  });
});
