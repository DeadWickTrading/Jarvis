import { approachAsymmetric, clamp01, rateFromPerFrame } from '../easing.js';
import type { AudioLevels } from '../types.js';

/**
 * Where the three bands sit in the spectrum, as fractions of the bin array.
 *
 * The mid band is deliberately narrow and low: human speech energy lives
 * there, and including the top of the spectrum would let room hiss and
 * sibilance drive the orb as hard as a voice.
 */
export interface BandConfig {
  /** Start of the voice band, as a fraction of the bin count. */
  readonly voiceStart?: number;
  /** End of the voice band, as a fraction of the bin count. */
  readonly voiceEnd?: number;
  /** How many bins from the bottom count as bass. */
  readonly bassBins?: number;
  /** Start of the treble band, as a fraction of the bin count. */
  readonly trebleStart?: number;
  /** Multiplier applied to the voice and bass bands. */
  readonly gain?: number;
  /** Floor added under the voice level so quiet passages still read. */
  readonly floor?: number;
}

export const DEFAULT_BANDS: Required<BandConfig> = {
  voiceStart: 0.1,
  voiceEnd: 0.6,
  bassBins: 6,
  trebleStart: 0.65,
  /**
   * A microphone at normal speaking distance fills maybe the bottom 40% of the
   * byte range, so an unscaled average reads as almost nothing. 2.4 brings a
   * normal voice to roughly full deflection without clipping on a shout.
   */
  gain: 2.4,
  floor: 0.05,
};

function meanOf(bins: Uint8Array, from: number, to: number): number {
  const start = Math.max(0, Math.min(bins.length, from));
  const end = Math.max(start, Math.min(bins.length, to));
  if (end <= start) return 0;
  let sum = 0;
  for (let i = start; i < end; i += 1) sum += bins[i];
  return sum / (end - start) / 255;
}

/**
 * Reduce a frequency-bin array to a voice envelope.
 *
 * Pure, and the reason the audio path is testable without a browser: feed it
 * a hand-built `Uint8Array` and assert the bands.
 */
export function analyseBins(bins: Uint8Array, config: BandConfig = {}): AudioLevels {
  const c = { ...DEFAULT_BANDS, ...config };
  const n = bins.length;
  if (n === 0) return { level: 0, bass: 0, treble: 0 };

  const voiceRaw = meanOf(bins, Math.floor(n * c.voiceStart), Math.ceil(n * c.voiceEnd));
  const bassRaw = meanOf(bins, 0, Math.min(n, c.bassBins));
  const trebleRaw = meanOf(bins, Math.floor(n * c.trebleStart), n);

  return {
    level: clamp01(voiceRaw * c.gain + c.floor),
    bass: clamp01(bassRaw * c.gain),
    treble: clamp01(trebleRaw * c.gain),
  };
}

/**
 * Asymmetric envelope follower.
 *
 * Audio levels arrive jittery at frame rate. Smoothing them symmetrically
 * either lags the attack (the orb responds late) or fails to hold between
 * syllables (the orb flickers). So: climb fast, fall slow.
 */
export interface LevelSmootherOptions {
  /** Fraction of the gap covered per 60fps frame while rising. */
  readonly attack?: number;
  /** Fraction of the gap covered per 60fps frame while falling. */
  readonly decay?: number;
}

export interface LevelSmoother {
  /** Advance by `dt` seconds toward `target`, and return the smoothed value. */
  update(target: AudioLevels, dt: number): AudioLevels;
  /** The most recent smoothed value. */
  current(): AudioLevels;
  /** Jump straight to a value, with no easing. */
  reset(to?: AudioLevels): void;
}

export function createLevelSmoother(options: LevelSmootherOptions = {}): LevelSmoother {
  const attackRate = rateFromPerFrame(options.attack ?? 0.45);
  const decayRate = rateFromPerFrame(options.decay ?? 0.08);

  let level = 0;
  let bass = 0;
  let treble = 0;

  return {
    update(target, dt) {
      level = approachAsymmetric(level, target.level, attackRate, decayRate, dt);
      bass = approachAsymmetric(bass, target.bass, attackRate, decayRate, dt);
      treble = approachAsymmetric(treble, target.treble, attackRate, decayRate, dt);
      return { level, bass, treble };
    },
    current: () => ({ level, bass, treble }),
    reset(to) {
      level = to?.level ?? 0;
      bass = to?.bass ?? 0;
      treble = to?.treble ?? 0;
    },
  };
}
