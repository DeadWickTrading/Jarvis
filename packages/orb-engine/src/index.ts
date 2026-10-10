/**
 * A living galaxy for an AI.
 *
 * One WebGL context, three passes: a nebula sky, a slowly turning network of
 * glowing star clusters, and a wireframe orb on top that carries the AI's
 * state and rides the waveform of real audio.
 */
export { createOrbScene, OrbEngine } from './scene/engine.js';

export { BRAND, CLUSTER_HUES, hexToRgb, rgbToHex, mixRgb } from './brand.js';
export type { Rgb } from './brand.js';

export { STATE_TABLE, initialParams, stepParams, activityLevel, cycledColor } from './states.js';
export type { SceneParams } from './states.js';

export {
  approach,
  approachAsymmetric,
  rateFromPerFrame,
  rateFromHalfLife,
  clamp,
  clamp01,
  lerp,
  smoothstep,
} from './easing.js';

export { analyseBins, createLevelSmoother, DEFAULT_BANDS } from './audio/levels.js';
export type { BandConfig, LevelSmoother, LevelSmootherOptions } from './audio/levels.js';
export { syntheticLevels } from './audio/synthetic.js';
export { createAudioTap, createAudioContextHolder } from './audio/tap.js';
export type { AudioTap, AudioContextHolder } from './audio/tap.js';

export { createPerfMonitor } from './perf.js';
export type { PerfMonitor, PerfMonitorOptions } from './perf.js';

export { createRng } from './random.js';
export type { Rng } from './random.js';

export { ORB_STATES, SILENCE } from './types.js';
export type {
  AudioLevels,
  AudioRoute,
  AudioTapSource,
  OrbSceneHandle,
  OrbSceneOptions,
  OrbState,
  PerformanceMode,
  PerformanceTier,
  StateTargets,
} from './types.js';
