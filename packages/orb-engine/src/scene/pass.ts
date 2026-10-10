import type * as THREE from 'three';
import type { AudioLevels, PerformanceTier } from '../types.js';
import type { SceneParams } from '../states.js';

/** Everything a pass needs to know about the current frame. */
export interface FrameContext {
  /** Seconds since the previous frame. */
  readonly dt: number;
  /**
   * The engine's own animation clock, in seconds.
   *
   * Not wall time: it advances at a rate the engine controls, which is how
   * reduced motion is honoured. Slowing a separate clock keeps every phase
   * continuous; multiplying wall time by a factor would make every sine in
   * every shader jump the instant the setting changed.
   */
  readonly animTime: number;
  /** A second clock advanced by the current state's noise speed. */
  readonly noiseTime: number;
  /** The eased visual parameters for this frame. */
  readonly params: SceneParams;
  /** The smoothed voice envelope for this frame. */
  readonly audio: AudioLevels;
  /** Primary colour after the slow state colour cycle. */
  readonly color: readonly [number, number, number];
  /** Combined excitement, already computed on the CPU. */
  readonly activity: number;
  /** 1 while a stream (real or synthetic) is feeding the orb, else 0. */
  readonly audioActive: number;
  /** Current rendering tier. */
  readonly tier: PerformanceTier;
}

/**
 * One render pass.
 *
 * The scene is three of these drawn into a single WebGL context, in order.
 * Keeping them behind an interface is what lets each layer be built and
 * debugged on its own: a pass can be commented out of the list and the rest
 * still renders.
 */
export interface ScenePass {
  /** Human-readable name, used in error messages. */
  readonly name: string;
  /**
   * Clear the depth buffer before drawing this pass, so it sits on top of
   * whatever came before regardless of distance.
   */
  readonly clearDepthBefore: boolean;
  /** Advance animation. Receives only numbers that are already computed. */
  update(ctx: FrameContext): void;
  /** Draw. Must not clear the colour buffer. */
  render(renderer: THREE.WebGLRenderer): void;
  /** React to a canvas resize. */
  resize(width: number, height: number): void;
  /** Rebuild or thin geometry for a new tier. */
  setTier(tier: PerformanceTier): void;
  /** Release every geometry, material and texture this pass owns. */
  dispose(): void;
}
