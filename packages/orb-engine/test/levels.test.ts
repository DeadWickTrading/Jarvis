import { describe, expect, it } from 'vitest';
import { analyseBins, createLevelSmoother, DEFAULT_BANDS } from '../src/audio/levels.js';

const SAMPLE_RATE = 48_000;
const BIN_COUNT = 1024; // what a 2048-point FFT produces
const PER_BIN = SAMPLE_RATE / 2 / BIN_COUNT;

/** Build a bin array holding energy only in the given frequency ranges. */
function spectrum(ranges: readonly (readonly [number, number])[], amplitude = 255): Uint8Array {
  const out = new Uint8Array(BIN_COUNT);
  for (const [lowHz, highHz] of ranges) {
    const start = Math.round(lowHz / PER_BIN);
    const end = Math.round(highHz / PER_BIN);
    for (let i = start; i < end && i < BIN_COUNT; i += 1) out[i] = amplitude;
  }
  return out;
}

const plain = { gain: 1, floor: 0, sampleRate: SAMPLE_RATE } as const;

describe('analyseBins', () => {
  it('reads the voice band where speech actually lives', () => {
    const { level, bass, treble } = analyseBins(spectrum([[180, 3600]]), plain);
    expect(level).toBeCloseTo(1, 6);
    expect(bass).toBe(0);
    expect(treble).toBe(0);
  });

  it('reads bass from the low end', () => {
    const { bass, level } = analyseBins(spectrum([[40, 180]]), plain);
    expect(bass).toBeCloseTo(1, 6);
    expect(level).toBe(0);
  });

  it('reads treble above the speech band', () => {
    const { treble, level } = analyseBins(spectrum([[3600, 9000]]), plain);
    expect(treble).toBeCloseTo(1, 6);
    expect(level).toBe(0);
  });

  it('keeps the bands from overlapping at their boundaries', () => {
    // Energy exactly at a boundary must not be counted twice.
    const atBoundary = analyseBins(spectrum([[180, 180 + PER_BIN]]), plain);
    expect(atBoundary.bass).toBe(0);
    expect(atBoundary.level).toBeGreaterThan(0);
  });

  /**
   * The case that matters, and the one a proportional band specification gets
   * wrong. Chromium's fake capture device emits a 440Hz tone; a band defined
   * as "bins 10%-60%" of a 0-24kHz analyser starts at 2.4kHz and would report
   * this as perfect silence.
   */
  it('hears a voice-range tone rather than reporting silence', () => {
    const tone = spectrum([[420, 460]]);
    const { level } = analyseBins(tone, { sampleRate: SAMPLE_RATE });
    expect(level).toBeGreaterThan(DEFAULT_BANDS.floor);
  });

  it('is not driven by sibilance or room hiss', () => {
    const hiss = analyseBins(spectrum([[9000, 20_000]]), { sampleRate: SAMPLE_RATE });
    const speech = analyseBins(spectrum([[200, 1200]]), { sampleRate: SAMPLE_RATE });
    expect(hiss.level).toBeCloseTo(DEFAULT_BANDS.floor, 6);
    expect(speech.level).toBeGreaterThan(hiss.level * 2);
  });

  it('tracks the same frequencies at a different sample rate', () => {
    const at48k = analyseBins(spectrum([[180, 3600]]), { ...plain, sampleRate: 48_000 });
    // The same signal captured at 44.1kHz lands in different bins entirely.
    const bins441 = new Uint8Array(BIN_COUNT);
    const perBin441 = 44_100 / 2 / BIN_COUNT;
    for (let i = Math.round(180 / perBin441); i < Math.round(3600 / perBin441); i += 1) {
      bins441[i] = 255;
    }
    const at441k = analyseBins(bins441, { gain: 1, floor: 0, sampleRate: 44_100 });
    expect(at441k.level).toBeCloseTo(at48k.level, 6);
  });

  it('applies the microphone boost so a normal voice reads near full', () => {
    // A microphone at speaking distance fills roughly the bottom 40%.
    const data = spectrum([[180, 3600]], Math.round(0.4 * 255));
    expect(analyseBins(data, plain).level).toBeCloseTo(0.4, 2);
    expect(analyseBins(data, { sampleRate: SAMPLE_RATE }).level).toBeGreaterThan(0.9);
    expect(DEFAULT_BANDS.gain).toBeCloseTo(2.4, 6);
  });

  it('keeps a small floor under the voice so quiet passages still read', () => {
    const silent = analyseBins(new Uint8Array(BIN_COUNT), { sampleRate: SAMPLE_RATE });
    expect(silent.level).toBeCloseTo(DEFAULT_BANDS.floor, 6);
    expect(silent.level).toBeGreaterThan(0);
    // Only the voice gets the floor; bass and treble report honestly.
    expect(silent.bass).toBe(0);
    expect(silent.treble).toBe(0);
  });

  it('clamps to 0..1 however loud the input', () => {
    const { level, bass, treble } = analyseBins(new Uint8Array(BIN_COUNT).fill(255));
    for (const v of [level, bass, treble]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('survives an empty or tiny bin array', () => {
    expect(analyseBins(new Uint8Array(0))).toEqual({ level: 0, bass: 0, treble: 0 });
    const tiny = analyseBins(new Uint8Array(3).fill(255));
    for (const v of Object.values(tiny)) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('puts the bass band in the first handful of bins at a 2048-point FFT', () => {
    // A sanity check on the chosen frequencies: this is what makes the low
    // band genuinely "the bottom few bins" at the resolution the tap uses.
    const lastBassBin = Math.round(DEFAULT_BANDS.bassHz[1] / PER_BIN);
    expect(lastBassBin).toBeGreaterThanOrEqual(5);
    expect(lastBassBin).toBeLessThanOrEqual(9);
  });
});

describe('createLevelSmoother', () => {
  it('attacks fast and decays slowly', () => {
    const smoother = createLevelSmoother();
    const loud = { level: 1, bass: 1, treble: 1 };
    const silent = { level: 0, bass: 0, treble: 0 };

    const afterOneLoudFrame = smoother.update(loud, 1 / 60).level;
    smoother.reset({ level: 1, bass: 1, treble: 1 });
    const droppedInOneFrame = 1 - smoother.update(silent, 1 / 60).level;

    expect(afterOneLoudFrame).toBeGreaterThan(0.4);
    expect(droppedInOneFrame).toBeLessThan(0.1);
    expect(afterOneLoudFrame).toBeGreaterThan(droppedInOneFrame * 4);
  });

  it('holds between syllables instead of flickering', () => {
    const smoother = createLevelSmoother();
    const loud = { level: 1, bass: 1, treble: 1 };
    const gap = { level: 0, bass: 0, treble: 0 };

    for (let i = 0; i < 8; i += 1) smoother.update(loud, 1 / 60);
    const peak = smoother.current().level;
    for (let i = 0; i < 6; i += 1) smoother.update(gap, 1 / 60);
    const trough = smoother.current().level;

    expect(trough).toBeGreaterThan(peak * 0.6);
  });

  it('is frame-rate independent', () => {
    const run = (steps: number) => {
      const smoother = createLevelSmoother();
      const target = { level: 0.8, bass: 0.5, treble: 0.3 };
      for (let i = 0; i < steps; i += 1) smoother.update(target, 1 / steps);
      return smoother.current();
    };
    const fine = run(120);
    const coarse = run(30);
    expect(fine.level).toBeCloseTo(coarse.level, 9);
    expect(fine.bass).toBeCloseTo(coarse.bass, 9);
    expect(fine.treble).toBeCloseTo(coarse.treble, 9);
  });

  it('starts at silence and resets to it', () => {
    const smoother = createLevelSmoother();
    expect(smoother.current()).toEqual({ level: 0, bass: 0, treble: 0 });
    smoother.update({ level: 1, bass: 1, treble: 1 }, 1);
    expect(smoother.current().level).toBeGreaterThan(0.5);
    smoother.reset();
    expect(smoother.current()).toEqual({ level: 0, bass: 0, treble: 0 });
  });
});
