import { BRAND, hexToRgb, mixRgb } from './brand.js';
import { approach, clamp01, rateFromPerFrame } from './easing.js';
import type { AudioLevels, OrbState, StateTargets } from './types.js';

const accent = hexToRgb(BRAND.accent);
const secondary = hexToRgb(BRAND.secondary);
const amber = hexToRgb(BRAND.listening);
const red = hexToRgb(BRAND.error);
const teal = hexToRgb(BRAND.success);
const cyan = hexToRgb(BRAND.cyan);
const ink = hexToRgb(BRAND.ink);

/** Amber pulled down toward the ink: an ember rather than a lamp. */
const ember = mixRgb(amber, ink, 0.45);
/** Red pulled down, so the error rim has somewhere darker to sit. */
const deepRed = mixRgb(red, ink, 0.5);

/**
 * THE state table.
 *
 * Every visual parameter for every state is defined here and nowhere else.
 * To change how a state looks, change a number in this object; no other file
 * needs touching. The renderer only ever consumes values that have already
 * been eased toward these targets.
 */
export const STATE_TABLE: Readonly<Record<OrbState, StateTargets>> = {
  /** A mind idling in deep space. Barely rippling, faint halo. */
  idle: {
    color: accent,
    colorSecondary: teal,
    colorCycle: 0,
    colorCyclePeriod: 12,
    opacity: 0.34,
    fresnelPower: 2.7,
    noiseSpeed: 0.12,
    amplitude: 0.12,
    baseNoise: 0.03,
    glow: 0.35,
    rotationSpeed: 0.05,
    ringOpacity: 0,
    pulse: 0,
    networkGain: 0,
    skyGain: 0.5,
    audioRoute: 'none',
    announcement: 'Idle',
  },

  /**
   * The microphone has been requested but no audio has arrived yet.
   *
   * Giving this its own state is the point: a user can tell "still waiting for
   * permission" apart from "listening to me", instead of watching a bright
   * recording light that is recording nothing.
   */
  arming: {
    color: ember,
    colorSecondary: amber,
    colorCycle: 0,
    colorCyclePeriod: 12,
    opacity: 0.42,
    fresnelPower: 2.4,
    noiseSpeed: 0.18,
    amplitude: 0.16,
    baseNoise: 0.055,
    glow: 0.45,
    rotationSpeed: 0.06,
    ringOpacity: 0,
    pulse: 0.1,
    networkGain: 0,
    skyGain: 0.55,
    audioRoute: 'none',
    announcement: 'Waiting for microphone access',
  },

  /** The recording light. Warm, wide awake, riding the user's voice. */
  listening: {
    color: amber,
    colorSecondary: accent,
    colorCycle: 0,
    colorCyclePeriod: 12,
    opacity: 0.72,
    fresnelPower: 1.9,
    noiseSpeed: 0.55,
    amplitude: 0.5,
    baseNoise: 0.075,
    glow: 0.95,
    rotationSpeed: 0.12,
    ringOpacity: 0,
    pulse: 0,
    // Listening affects only the orb. The galaxy answers the AI, not the user.
    networkGain: 0,
    skyGain: 0.6,
    audioRoute: 'mic',
    announcement: 'Listening',
  },

  /** Colour flows lime to violet, rings appear, rotation picks up. */
  processing: {
    color: accent,
    colorSecondary: secondary,
    colorCycle: 1,
    colorCyclePeriod: 9,
    opacity: 0.62,
    fresnelPower: 2.1,
    noiseSpeed: 0.42,
    amplitude: 0.3,
    baseNoise: 0.07,
    glow: 0.7,
    rotationSpeed: 0.28,
    ringOpacity: 0.5,
    pulse: 0.3,
    networkGain: 0.6,
    skyGain: 0.8,
    audioRoute: 'none',
    announcement: 'Thinking',
  },

  /** The whole galaxy lights up with its voice. */
  speaking: {
    color: accent,
    colorSecondary: cyan,
    colorCycle: 0.15,
    colorCyclePeriod: 14,
    opacity: 0.78,
    fresnelPower: 1.8,
    noiseSpeed: 0.6,
    amplitude: 0.46,
    baseNoise: 0.075,
    glow: 1,
    rotationSpeed: 0.14,
    ringOpacity: 0.08,
    pulse: 0,
    networkGain: 1,
    skyGain: 1,
    audioRoute: 'playback',
    announcement: 'Speaking',
  },

  /** Red, still, sharp. Nothing moves; the edge goes hard. */
  error: {
    color: red,
    colorSecondary: deepRed,
    colorCycle: 0,
    colorCyclePeriod: 12,
    opacity: 0.7,
    fresnelPower: 3.4,
    noiseSpeed: 0.02,
    amplitude: 0.05,
    baseNoise: 0.028,
    glow: 0.5,
    rotationSpeed: 0,
    ringOpacity: 0,
    pulse: 0,
    networkGain: 0,
    skyGain: 0.45,
    audioRoute: 'none',
    announcement: 'Error',
  },
};

/** The numeric parameters that ease. Colours are handled separately. */
const SCALAR_KEYS = [
  'colorCycle',
  'colorCyclePeriod',
  'opacity',
  'fresnelPower',
  'noiseSpeed',
  'amplitude',
  'baseNoise',
  'glow',
  'rotationSpeed',
  'ringOpacity',
  'pulse',
  'networkGain',
  'skyGain',
] as const;

type ScalarKey = (typeof SCALAR_KEYS)[number];

/** The eased, currently-displayed value of every parameter in the table. */
export type SceneParams = { -readonly [K in ScalarKey]: number } & {
  color: [number, number, number];
  colorSecondary: [number, number, number];
};

/**
 * How fast parameters chase their targets, as the fraction of the remaining
 * gap covered per frame at 60fps. A full state change reads as complete in
 * roughly a second, which is the brief: smooth, but not sluggish.
 */
const TRANSITION_RATE = rateFromPerFrame(0.06);
/** Colour crossfades a touch slower so hue changes read as a flow, not a flip. */
const COLOR_RATE = rateFromPerFrame(0.045);

/** Build a parameter set sitting exactly on a state's targets. */
export function initialParams(state: OrbState): SceneParams {
  const t = STATE_TABLE[state];
  const params = {
    color: [...t.color] as [number, number, number],
    colorSecondary: [...t.colorSecondary] as [number, number, number],
  } as SceneParams;
  for (const key of SCALAR_KEYS) params[key] = t[key];
  return params;
}

/**
 * Ease every parameter one step toward `state`'s targets.
 *
 * Mutates and returns `params`. Frame-rate independent: the result depends on
 * total elapsed time, not on how many steps it was split into.
 */
export function stepParams(params: SceneParams, state: OrbState, dt: number): SceneParams {
  const t = STATE_TABLE[state];
  for (const key of SCALAR_KEYS) {
    params[key] = approach(params[key], t[key], TRANSITION_RATE, dt);
  }
  for (let i = 0; i < 3; i += 1) {
    params.color[i] = approach(params.color[i], t.color[i], COLOR_RATE, dt);
    params.colorSecondary[i] = approach(
      params.colorSecondary[i],
      t.colorSecondary[i],
      COLOR_RATE,
      dt,
    );
  }
  return params;
}

/**
 * The orb's effective excitement for a frame: baseline, plus a slow breath,
 * plus whatever the voice is doing, plus the thinking pulse.
 *
 * Keeping this a pure function is what makes "calm at rest" testable. The
 * noise field in the vertex shader is multiplied by this, so when it is small
 * the mesh barely moves no matter what the noise says.
 */
export function activityLevel(
  params: SceneParams,
  audio: AudioLevels,
  animTime: number,
): number {
  const breath = Math.sin(animTime * 0.7) * 0.04;
  const pulse = params.pulse > 0 ? (Math.sin(animTime * 1.9) * 0.5 + 0.5) * params.pulse * 0.12 : 0;
  const voice = audio.level * params.amplitude * 0.55 + audio.bass * params.amplitude * 0.35;
  return Math.max(0, params.baseNoise + breath + pulse + voice);
}

/**
 * The primary colour actually shown this frame, after the slow state cycle.
 * While thinking, this walks lime to violet and back.
 */
export function cycledColor(
  params: SceneParams,
  animTime: number,
): [number, number, number] {
  if (params.colorCycle <= 0.0001) return params.color;
  const period = Math.max(0.5, params.colorCyclePeriod);
  const phase = (Math.sin((animTime * Math.PI * 2) / period) * 0.5 + 0.5) * clamp01(params.colorCycle);
  const mixed = mixRgb(params.color, params.colorSecondary, phase);
  return [mixed[0], mixed[1], mixed[2]];
}
