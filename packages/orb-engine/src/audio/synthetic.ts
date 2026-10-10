import { clamp01, smoothstep } from '../easing.js';
import type { AudioLevels } from '../types.js';

const TAU = Math.PI * 2;

/**
 * A deterministic stand-in for a voice.
 *
 * Used when a state wants audio but no real stream is attached — a demo page
 * with no microphone permission, a server-rendered preview, a visual test. It
 * is a pure function of time, so the same moment always produces the same
 * envelope and screenshots stay comparable.
 *
 * The shape is what makes it read as speech rather than as a sine wave:
 * syllables at roughly three per second, slightly jittered, grouped into
 * phrases by a slow envelope that genuinely closes, so there are pauses.
 */
export function syntheticLevels(time: number, seed = 1): AudioLevels {
  // Seed only shifts phase, so every seed gives the same character.
  const p = (seed % 16) * 0.61;

  // Syllables: ~3.2Hz, with its own rate wobble so the rhythm is not metronomic.
  const jitter = 0.4 * Math.sin(time * TAU * 0.77 + p);
  const syllableRaw = 0.5 + 0.5 * Math.sin(time * TAU * 3.2 + jitter + p);
  // Sharpen: speech is bursts with gaps, not a smooth oscillation.
  const syllable = Math.pow(syllableRaw, 1.6);

  // Phrases: a slow swell that dips below the gate to create real silence.
  const phrase = clamp01(
    0.6 + 0.42 * Math.sin(time * TAU * 0.19 + 1.1 + p) + 0.18 * Math.sin(time * TAU * 0.07 + p),
  );
  const gate = smoothstep(0.22, 0.55, phrase);

  const level = clamp01(syllable * phrase * gate);
  const bass = clamp01(
    (0.55 * syllable + 0.45 * (0.5 + 0.5 * Math.sin(time * TAU * 1.7 + p))) * gate * 0.8,
  );
  const treble = clamp01(
    Math.pow(syllable, 3) * gate * 0.7 * (0.6 + 0.4 * (0.5 + 0.5 * Math.sin(time * TAU * 5.3 + p))),
  );

  return { level, bass, treble };
}
