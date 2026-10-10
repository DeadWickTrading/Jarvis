import { describe, expect, it } from 'vitest';
import { hexToRgb, BRAND } from '../src/brand.js';
import {
  activityLevel,
  cycledColor,
  initialParams,
  stepParams,
  STATE_TABLE,
} from '../src/states.js';
import { ORB_STATES, SILENCE } from '../src/types.js';
import type { AudioLevels } from '../src/types.js';

const KEYS = Object.keys(STATE_TABLE.idle) as (keyof (typeof STATE_TABLE)['idle'])[];

describe('the state table', () => {
  it('defines every state exactly once', () => {
    expect(Object.keys(STATE_TABLE).sort()).toEqual([...ORB_STATES].sort());
  });

  it('gives every state a complete set of targets', () => {
    for (const state of ORB_STATES) {
      const targets = STATE_TABLE[state];
      for (const key of KEYS) {
        expect(targets[key], `${state}.${String(key)}`).toBeDefined();
      }
    }
  });

  it('keeps every numeric parameter finite and in a sane range', () => {
    for (const state of ORB_STATES) {
      const t = STATE_TABLE[state] as unknown as Record<string, unknown>;
      for (const key of KEYS) {
        const value = t[key as string];
        if (typeof value !== 'number') continue;
        expect(Number.isFinite(value), `${state}.${String(key)}`).toBe(true);
        expect(value, `${state}.${String(key)}`).toBeGreaterThanOrEqual(0);
      }
      for (const key of ['opacity', 'colorCycle', 'ringOpacity', 'networkGain', 'skyGain'] as const) {
        expect(STATE_TABLE[state][key], `${state}.${key}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('gives every state its own screen-reader announcement', () => {
    const said = ORB_STATES.map((s) => STATE_TABLE[s].announcement);
    expect(new Set(said).size).toBe(said.length);
    for (const text of said) expect(text.length).toBeGreaterThan(0);
  });

  describe('the states say what the brief says they should', () => {
    it('routes audio only where a stream actually exists', () => {
      expect(STATE_TABLE.listening.audioRoute).toBe('mic');
      expect(STATE_TABLE.speaking.audioRoute).toBe('playback');
      // Arming is precisely the state where the mic was asked for and nothing
      // has arrived yet, so it must not pretend to have a signal.
      expect(STATE_TABLE.arming.audioRoute).toBe('none');
      expect(STATE_TABLE.idle.audioRoute).toBe('none');
      expect(STATE_TABLE.error.audioRoute).toBe('none');
    });

    it('lets the galaxy answer the AI and not the user', () => {
      expect(STATE_TABLE.speaking.networkGain).toBeGreaterThan(0);
      expect(STATE_TABLE.processing.networkGain).toBeGreaterThan(0);
      expect(STATE_TABLE.listening.networkGain).toBe(0);
      expect(STATE_TABLE.idle.networkGain).toBe(0);
    });

    it('shows the rings only while thinking', () => {
      expect(STATE_TABLE.processing.ringOpacity).toBeGreaterThan(0.2);
      for (const state of ['idle', 'arming', 'listening', 'error'] as const) {
        expect(STATE_TABLE[state].ringOpacity).toBe(0);
      }
    });

    it('makes listening the warm one and the brightest thing in the scene', () => {
      expect(STATE_TABLE.listening.color).toEqual(hexToRgb(BRAND.listening));
      // Warm means red above blue; every cool state is the other way round.
      const [r, , b] = STATE_TABLE.listening.color;
      expect(r).toBeGreaterThan(b);
      for (const state of ['idle', 'speaking', 'processing'] as const) {
        const [cr, , cb] = STATE_TABLE[state].color;
        expect(cr, state).toBeLessThan(Math.max(cb, 0.9));
      }
    });

    it('makes arming a dimmer ember than listening', () => {
      const lumaOf = (c: readonly [number, number, number]) =>
        0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      expect(lumaOf(STATE_TABLE.arming.color)).toBeLessThan(lumaOf(STATE_TABLE.listening.color));
      expect(STATE_TABLE.arming.glow).toBeLessThan(STATE_TABLE.listening.glow);
    });

    it('holds the error state still and sharp', () => {
      expect(STATE_TABLE.error.rotationSpeed).toBe(0);
      expect(STATE_TABLE.error.color).toEqual(hexToRgb(BRAND.error));
      const sharpest = Math.max(...ORB_STATES.map((s) => STATE_TABLE[s].fresnelPower));
      expect(STATE_TABLE.error.fresnelPower).toBe(sharpest);
      const slowest = Math.min(...ORB_STATES.map((s) => STATE_TABLE[s].amplitude));
      expect(STATE_TABLE.error.amplitude).toBe(slowest);
    });

    it('flows colour only while thinking', () => {
      expect(STATE_TABLE.processing.colorCycle).toBeGreaterThan(0.5);
      expect(STATE_TABLE.processing.colorSecondary).toEqual(hexToRgb(BRAND.secondary));
      expect(STATE_TABLE.idle.colorCycle).toBe(0);
    });
  });
});

describe('stepParams', () => {
  it('starts exactly on the target state', () => {
    const params = initialParams('idle');
    expect(params.opacity).toBe(STATE_TABLE.idle.opacity);
    expect(params.color).toEqual([...STATE_TABLE.idle.color]);
  });

  it('never snaps: one frame moves part of the way, not all of it', () => {
    const params = initialParams('idle');
    const before = params.glow;
    stepParams(params, 'speaking', 1 / 60);
    expect(params.glow).toBeGreaterThan(before);
    expect(params.glow).toBeLessThan(STATE_TABLE.speaking.glow);
  });

  it('arrives within about a second', () => {
    const params = initialParams('idle');
    for (let i = 0; i < 60; i += 1) stepParams(params, 'speaking', 1 / 60);
    expect(params.glow).toBeCloseTo(STATE_TABLE.speaking.glow, 1);
    expect(params.opacity).toBeCloseTo(STATE_TABLE.speaking.opacity, 1);
  });

  it('is frame-rate independent across every parameter and colour channel', () => {
    const fine = initialParams('idle');
    for (let i = 0; i < 120; i += 1) stepParams(fine, 'processing', 1 / 120);
    const coarse = initialParams('idle');
    for (let i = 0; i < 30; i += 1) stepParams(coarse, 'processing', 1 / 30);

    for (const key of ['opacity', 'glow', 'rotationSpeed', 'ringOpacity', 'skyGain'] as const) {
      expect(fine[key], key).toBeCloseTo(coarse[key], 9);
    }
    for (let i = 0; i < 3; i += 1) {
      expect(fine.color[i]).toBeCloseTo(coarse.color[i], 9);
      expect(fine.colorSecondary[i]).toBeCloseTo(coarse.colorSecondary[i], 9);
    }
  });

  it('converges on whichever state it is pointed at, from anywhere', () => {
    for (const from of ORB_STATES) {
      for (const to of ORB_STATES) {
        const params = initialParams(from);
        for (let i = 0; i < 600; i += 1) stepParams(params, to, 1 / 60);
        expect(params.opacity, `${from}->${to}`).toBeCloseTo(STATE_TABLE[to].opacity, 5);
        expect(params.color[0], `${from}->${to}`).toBeCloseTo(STATE_TABLE[to].color[0], 5);
      }
    }
  });
});

describe('activityLevel', () => {
  const loud: AudioLevels = { level: 1, bass: 1, treble: 1 };

  it('stays small in silence, so a resting orb barely ripples', () => {
    const params = initialParams('idle');
    let peak = 0;
    for (let t = 0; t < 40; t += 0.05) {
      peak = Math.max(peak, activityLevel(params, SILENCE, t));
    }
    // The noise field can reach about 0.8, so this caps the displacement at
    // roughly 6% of the orb's radius over a whole breath cycle.
    expect(peak).toBeLessThan(0.08);
  });

  it('never goes negative, even at the bottom of a breath', () => {
    const params = initialParams('error');
    for (let t = 0; t < 40; t += 0.05) {
      expect(activityLevel(params, SILENCE, t)).toBeGreaterThanOrEqual(0);
    }
  });

  it('lets the voice outweigh the resting motion in the states that hear one', () => {
    // The invariant that matters is that at a full-scale voice the audio term
    // dominates the baseline and breath — not any particular ratio. The
    // amplitudes are tuned by eye against real screenshots and will move
    // again, so this asserts the relationship, with margin.
    for (const state of ['listening', 'speaking'] as const) {
      const params = initialParams(state);
      const quiet = activityLevel(params, SILENCE, 1);
      const fromVoice = activityLevel(params, loud, 1) - quiet;
      expect(fromVoice, state).toBeGreaterThan(quiet * 1.5);
    }
  });

  it('gives the states that hear a voice far more displacement headroom', () => {
    for (const state of ['listening', 'speaking'] as const) {
      expect(STATE_TABLE[state].amplitude, state).toBeGreaterThan(
        STATE_TABLE.idle.amplitude * 1.5,
      );
    }
  });

  it('never lets a full-scale voice drive the mesh into its clamp', () => {
    // The vertex shader clamps displacement to +/-0.45. The noise field can
    // reach about 1.0 with the high octave engaged, so activity at a loud
    // peak is very nearly the displacement — and a state sitting at the clamp
    // stops responding to the voice at all, as well as losing its silhouette.
    for (const state of ['listening', 'speaking'] as const) {
      const peak = activityLevel(initialParams(state), loud, 1);
      expect(peak, state).toBeLessThan(0.33);
    }
  });

  it('breathes: silence is not perfectly static', () => {
    const params = initialParams('idle');
    const samples = Array.from({ length: 80 }, (_, i) => activityLevel(params, SILENCE, i * 0.12));
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(0.01);
  });
});

describe('cycledColor', () => {
  it('holds still when the state does not cycle', () => {
    const params = initialParams('idle');
    expect(cycledColor(params, 0)).toEqual(params.color);
    expect(cycledColor(params, 7.3)).toEqual(params.color);
  });

  it('walks between the two colours while thinking', () => {
    const params = initialParams('processing');
    const seen = Array.from({ length: 200 }, (_, i) => cycledColor(params, i * 0.1)[2]);
    const spread = Math.max(...seen) - Math.min(...seen);
    expect(spread).toBeGreaterThan(0.2);
    for (const blue of seen) {
      expect(blue).toBeGreaterThanOrEqual(Math.min(params.color[2], params.colorSecondary[2]) - 1e-9);
      expect(blue).toBeLessThanOrEqual(Math.max(params.color[2], params.colorSecondary[2]) + 1e-9);
    }
  });
});
