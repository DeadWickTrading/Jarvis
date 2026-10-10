import { approachAsymmetric, clamp01, rateFromPerFrame } from '../easing.js';
import type { AudioLevels } from '../types.js';

/**
 * Where the three bands sit, in hertz.
 *
 * A note on why these are frequencies rather than fractions of the bin array.
 *
 * It is tempting to specify the bands proportionally — "the voice is the
 * middle of the spectrum, say bins 10% to 60%". On a Web Audio analyser that
 * does not land where you expect. The bins span zero to the Nyquist
 * frequency, which at the usual 48kHz sample rate is 24kHz, so 10%-60% is
 * 2.4kHz to 14.4kHz. Human speech energy is almost entirely below 3.5kHz:
 * that band contains sibilance, room hiss and very little voice, and an orb
 * driven by it responds to "s" sounds and air conditioning while sitting
 * still through a vowel.
 *
 * Naming the frequencies instead makes the intent checkable and keeps the
 * bands correct whatever sample rate and FFT size the device happens to use.
 * As a sanity check on the numbers: at a 2048-point FFT and 48kHz, the bass
 * band below comes out as the first six bins.
 */
export interface BandConfig {
  /** Analyser sample rate. Bins span 0 to half of this. */
  readonly sampleRate?: number;
  /** The band that tracks a voice: fundamentals and the first formants. */
  readonly voiceHz?: readonly [number, number];
  /** Low end — the push behind a syllable. */
  readonly bassHz?: readonly [number, number];
  /** High end — sibilance and detail. */
  readonly trebleHz?: readonly [number, number];
  /** Multiplier applied to all three bands. */
  readonly gain?: number;
  /** Floor added under the voice level so quiet passages still read. */
  readonly floor?: number;
}

export const DEFAULT_BANDS: Required<BandConfig> = {
  sampleRate: 48_000,
  /** Roughly the telephone band: where speech actually lives. */
  voiceHz: [180, 3600],
  bassHz: [40, 180],
  trebleHz: [3600, 9000],
  /**
   * A microphone at normal speaking distance fills maybe the bottom 40% of
   * the byte range, so an unscaled average reads as almost nothing. 2.4 brings
   * a normal voice to roughly full deflection without clipping on a shout.
   */
  gain: 2.4,
  floor: 0.05,
};

/** Mean of the bins covering `[lowHz, highHz)`, normalised to 0..1. */
function bandMean(
  bins: Uint8Array,
  sampleRate: number,
  lowHz: number,
  highHz: number,
): number {
  const nyquist = sampleRate / 2;
  if (!(nyquist > 0) || bins.length === 0) return 0;

  const perBin = nyquist / bins.length;
  // Round both edges the same way, so adjacent bands meet exactly rather than
  // sharing a bin at the boundary.
  const start = Math.max(0, Math.min(bins.length, Math.round(lowHz / perBin)));
  // At least one bin, so a band narrower than the resolution still reports.
  const end = Math.max(start + 1, Math.min(bins.length, Math.round(highHz / perBin)));
  if (start >= bins.length) return 0;

  let sum = 0;
  for (let i = start; i < end; i += 1) sum += bins[i]!;
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
  if (bins.length === 0) return { level: 0, bass: 0, treble: 0 };

  const voice = bandMean(bins, c.sampleRate, c.voiceHz[0], c.voiceHz[1]);
  const bass = bandMean(bins, c.sampleRate, c.bassHz[0], c.bassHz[1]);
  const treble = bandMean(bins, c.sampleRate, c.trebleHz[0], c.trebleHz[1]);

  return {
    level: clamp01(voice * c.gain + c.floor),
    bass: clamp01(bass * c.gain),
    treble: clamp01(treble * c.gain),
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
