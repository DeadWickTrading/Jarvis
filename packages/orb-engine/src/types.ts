import type { Rgb } from './brand.js';

/** What the AI is doing. Every visual in the scene derives from this. */
export type OrbState = 'idle' | 'arming' | 'listening' | 'processing' | 'speaking' | 'error';

/** All six states, in the order a conversation visits them. */
export const ORB_STATES: readonly OrbState[] = [
  'idle',
  'arming',
  'listening',
  'processing',
  'speaking',
  'error',
] as const;

/** Which audio stream, if any, drives the orb in a given state. */
export type AudioRoute = 'none' | 'mic' | 'playback';

/**
 * The full set of visual targets for one state.
 *
 * Every animated parameter in the scene appears here exactly once. Each frame
 * the live values ease toward the current state's entry; nothing snaps.
 */
export interface StateTargets {
  /** Primary orb colour. */
  readonly color: Rgb;
  /** Colour the displaced parts of the mesh tint toward. */
  readonly colorSecondary: Rgb;
  /** 0 holds `color`; 1 cycles slowly between `color` and `colorSecondary`. */
  readonly colorCycle: number;
  /** Seconds for one full colour cycle. Ignored when `colorCycle` is 0. */
  readonly colorCyclePeriod: number;
  /** Wireframe opacity. */
  readonly opacity: number;
  /** Fresnel exponent. Higher is a thinner, sharper rim. */
  readonly fresnelPower: number;
  /** How fast the displacement noise field evolves. */
  readonly noiseSpeed: number;
  /** Displacement amplitude multiplier. */
  readonly amplitude: number;
  /** Baseline activity, present even in silence, so the orb always breathes. */
  readonly baseNoise: number;
  /** Strength of the additive glow shell. */
  readonly glow: number;
  /** Orb rotation speed in radians per second. */
  readonly rotationSpeed: number;
  /** Opacity of the three orbital rings. */
  readonly ringOpacity: number;
  /** Amplitude of the slow non-audio pulse (used while thinking). */
  readonly pulse: number;
  /** How strongly the voice level drives the star network. */
  readonly networkGain: number;
  /** Nebula and bloom brightness in the sky pass. */
  readonly skyGain: number;
  /** Which stream feeds the orb's waveform in this state. */
  readonly audioRoute: AudioRoute;
  /** Text announced to screen readers when this state becomes current. */
  readonly announcement: string;
}

/** Voice envelope for one frame, all components in 0..1. */
export interface AudioLevels {
  /** Average of the mid band — the part that tracks a voice. */
  readonly level: number;
  /** Low band — the push behind a syllable. */
  readonly bass: number;
  /** High band — sibilance and detail. */
  readonly treble: number;
}

/** Zero audio. */
export const SILENCE: AudioLevels = { level: 0, bass: 0, treble: 0 };

/** Rendering tier. `low` is the thinned, cheaper scene. */
export type PerformanceTier = 'high' | 'low';

/** How the tier is chosen. */
export type PerformanceMode = 'auto' | 'high' | 'low';

/** Anything the engine can tap for a waveform without altering playback. */
export type AudioTapSource = MediaStream | AudioNode | HTMLMediaElement;

/** Options for {@link createOrbScene}. */
/** Silhouette of the central subject. */
export type OrbShape = 'orb' | 'wick' | 'cat';

export interface OrbSceneOptions {
  /** Starting state. Defaults to `idle`. */
  readonly initialState?: OrbState;
  /** Layout seed. The same seed always produces the same galaxy. */
  readonly seed?: number;
  /** Performance tier selection. Defaults to `auto`. */
  readonly performanceMode?: PerformanceMode;
  /**
   * The subject's silhouette. `orb` (default) is the noise-displaced sphere;
   * `wick` bends the same wireframe mesh into a candle body with a wick above
   * and below - the "i" in the Jarwick wordmark. Same shader, glow and rings.
   */
  readonly shape?: OrbShape;
  /**
   * Big trades orbiting the subject: lime buy / red sell cubes in three tilted
   * bands, joined into constellations, sized like order-flow prints (mostly
   * small, a few blocks). Defaults to false.
   */
  readonly trades?: boolean;
  /**
   * Draw the nebula sky and the star network behind the subject. Defaults to
   * true. `false` draws the subject alone on the ink: the cheapest scene, for
   * a page that only needs the candle.
   */
  readonly background?: boolean;
  /**
   * Colour scheme. `lime` (default) is the original; `violet` rests in P2P
   * violet, listens in cyan, thinks in amber/orange and speaks in Wick lime.
   */
  readonly palette?: 'lime' | 'violet';
  /**
   * Honour the OS reduce-motion setting. Defaults to true. When reduced motion
   * is active the engine slows its own animation clock rather than scaling
   * elapsed time, so phases stay continuous across the change.
   */
  readonly respectReducedMotion?: boolean;
  /**
   * Use the deterministic synthetic envelope when a state wants audio but no
   * real stream is attached. Defaults to true.
   */
  readonly syntheticAudioFallback?: boolean;
  /** Announce state changes in an ARIA live region. Defaults to true. */
  readonly announceState?: boolean;
  /** Upper bound on device pixel ratio in the `high` tier. Defaults to 2. */
  readonly maxPixelRatio?: number;
}

/**
 * Live control of the candle when the shape is `wick`.
 *
 * Units are the candle's own: y up, the resting body spans -0.78..0.78 and
 * the resting wicks reach 1.42 and -1.3. A host moves the body and wicks
 * each frame (it owns the physics); the engine eases the last step so the
 * mesh never snaps. `null` for any field, or for the whole control, hands
 * that part back to the engine's resting candle.
 */
export interface CandleControl {
  /** Body bottom, in candle units. */
  readonly bottom: number;
  /** Body top, in candle units. Must be >= bottom. */
  readonly top: number;
  /** Lower wick end. Defaults to a short wick under the body. */
  readonly low?: number;
  /** Upper wick end. Defaults to a short wick above the body. */
  readonly high?: number;
  /** Colour override, 0..1 rgb, eased in. `null` returns to the state table. */
  readonly color?: Rgb | null;
  /** A horizontal level drawn across the scene at `y`, or `null` for none. */
  readonly level?: { readonly y: number; readonly color: Rgb; readonly opacity: number } | null;
}

/** How candle units map to the container, for a host doing its own physics. */
export interface CandleMetrics {
  /** Container pixels per candle unit. */
  readonly pxPerUnit: number;
  /** Container x, in pixels, of the candle's centre line. */
  readonly originX: number;
  /** Container y, in pixels, of candle y = 0. */
  readonly originY: number;
}

/** The engine's public surface. Everything a host page needs, nothing more. */
export interface OrbSceneHandle {
  /** Drive the candle (shape `wick` only). `null` returns it to rest. */
  setCandle(control: CandleControl | null): void;
  /** Pixel mapping of candle units, for the host's pointer maths. */
  getCandleMetrics(): CandleMetrics;
  /** Move to a state. Transitions are always eased. */
  setState(state: OrbState): void;
  /** The current state. */
  getState(): OrbState;
  /** Attach or detach the microphone tap. Pass `null` to detach. */
  setMicSource(source: AudioTapSource | null): void;
  /** Attach or detach the playback tap. Pass `null` to detach. */
  setPlaybackSource(source: AudioTapSource | null): void;
  /** Override the performance tier, or hand control back with `auto`. */
  setPerformanceMode(mode: PerformanceMode): void;
  /** The tier currently in force. */
  getPerformanceTier(): PerformanceTier;
  /** The voice envelope used for the most recent frame. */
  getAudioLevels(): AudioLevels;
  /**
   * The engine's AudioContext, created on first use.
   *
   * Any `AudioNode` passed to {@link setMicSource} or {@link setPlaybackSource}
   * must belong to this context: Web Audio refuses to connect nodes across
   * contexts. A host synthesising its own audio should build it here.
   */
  getAudioContext(): AudioContext;
  /** Frames per second, averaged over the last second. */
  getFps(): number;
  /** Stop the loop, release the WebGL context and dispose every resource. */
  destroy(): void;
}
