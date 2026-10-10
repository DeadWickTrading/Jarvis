import * as THREE from 'three';
import { BRAND, hexToRgb } from '../brand.js';
import { approach, clamp, rateFromPerFrame } from '../easing.js';
import { analyseBins, createLevelSmoother } from '../audio/levels.js';
import { syntheticLevels } from '../audio/synthetic.js';
import { createAudioContextHolder, createAudioTap, type AudioTap } from '../audio/tap.js';
import { createPerfMonitor } from '../perf.js';
import { activityLevel, cycledColor, initialParams, stepParams, STATE_TABLE } from '../states.js';
import type {
  AudioLevels,
  AudioTapSource,
  OrbSceneHandle,
  OrbSceneOptions,
  OrbState,
  PerformanceMode,
  PerformanceTier,
} from '../types.js';
import { SILENCE } from '../types.js';
import { srgbColor } from './color.js';
import { OrbPass } from './orb.js';
import { SkyPass } from './sky.js';
import type { FrameContext, ScenePass } from './pass.js';

/** Pixel ratio ceiling per tier. The low tier always renders 1:1. */
const TIER_PIXEL_RATIO: Record<PerformanceTier, number> = { high: 2, low: 1 };

/**
 * How much slower the animation clock runs under `prefers-reduced-motion`.
 *
 * Note this scales the *clock's rate*, not elapsed time: `animTime` keeps
 * accumulating from wherever it had reached. Scaling wall time instead
 * (`animTime = now * 0.35`) would teleport every sine in every shader the
 * instant the setting changed.
 */
const REDUCED_MOTION_SCALE = 0.3;

/** Longest frame we will integrate. Guards against tab-switch time jumps. */
const MAX_FRAME_SECONDS = 0.1;

/** Playback is already mastered at a sane level, so it needs less lift than a mic. */
const PLAYBACK_BANDS = { gain: 1.6, floor: 0.03 } as const;

export class OrbEngine implements OrbSceneHandle {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly canvas: HTMLCanvasElement;
  private readonly liveRegion: HTMLElement | null;

  private readonly passes: ScenePass[];
  private readonly orbPass: OrbPass;
  private skyPass!: SkyPass;

  private readonly params = initialParams('idle');
  private state: OrbState;

  /** Reduced-motion-scaled clock driving every visual phase. */
  private animTime = 0;
  /** Noise phase, advanced by the current state's noise speed. */
  private noiseTime = 0;
  /** Real-time clock for the synthetic audio envelope. */
  private audioClock = 0;
  private lastFrameMs = 0;
  private frameHandle = 0;

  private readonly audioHolder = createAudioContextHolder();
  private readonly smoother = createLevelSmoother();
  private micTap: AudioTap | null = null;
  private playbackTap: AudioTap | null = null;
  private audio: AudioLevels = SILENCE;
  private audioActive = 0;

  private readonly perf = createPerfMonitor();
  private perfMode: PerformanceMode;
  private tier: PerformanceTier;

  private readonly maxPixelRatio: number;
  private readonly syntheticFallback: boolean;
  private motionScale = 1;

  private resizeObserver: ResizeObserver | null = null;
  private motionQuery: MediaQueryList | null = null;
  private readonly onMotionChange: () => void;
  private destroyed = false;
  private width = 1;
  private height = 1;

  constructor(container: HTMLElement, options: OrbSceneOptions = {}) {
    this.container = container;
    this.state = options.initialState ?? 'idle';
    this.perfMode = options.performanceMode ?? 'auto';
    this.tier = this.perfMode === 'low' ? 'low' : 'high';
    this.maxPixelRatio = options.maxPixelRatio ?? 2;
    this.syntheticFallback = options.syntheticAudioFallback ?? true;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.canvas = this.renderer.domElement;
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';

    // One context, three passes, drawn in order. Nothing clears but us.
    this.renderer.autoClear = false;
    this.renderer.setClearColor(srgbColor(hexToRgb(BRAND.ink)), 1);

    container.appendChild(this.canvas);

    this.orbPass = new OrbPass(this.tier);
    // Drawn in this order every frame: sky, then the star network, then the
    // orb on a cleared depth buffer. One context, three passes.
    this.skyPass = new SkyPass(this.tier);
    this.passes = [this.skyPass, this.orbPass];

    this.liveRegion = (options.announceState ?? true) ? this.createLiveRegion() : null;

    this.onMotionChange = () => {
      const reduced = this.motionQuery?.matches ?? false;
      this.motionScale = reduced ? REDUCED_MOTION_SCALE : 1;
    };
    if (options.respectReducedMotion ?? true) {
      this.motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.motionQuery.addEventListener('change', this.onMotionChange);
      this.onMotionChange();
    }

    this.observeSize();
    this.applyTier(this.tier, true);
    this.announce();

    this.lastFrameMs = performance.now();
    this.frameHandle = requestAnimationFrame(this.frame);
  }

  // --- public API ---------------------------------------------------------

  setState(state: OrbState): void {
    if (this.destroyed || state === this.state) return;
    if (!(state in STATE_TABLE)) throw new Error(`Unknown orb state: ${String(state)}`);
    this.state = state;
    this.announce();
  }

  getState(): OrbState {
    return this.state;
  }

  setMicSource(source: AudioTapSource | null): void {
    this.micTap = this.swapTap(this.micTap, source);
  }

  setPlaybackSource(source: AudioTapSource | null): void {
    this.playbackTap = this.swapTap(this.playbackTap, source);
  }

  setPerformanceMode(mode: PerformanceMode): void {
    this.perfMode = mode;
    if (mode === 'auto') {
      this.perf.reset();
      this.applyTier('high');
    } else {
      this.applyTier(mode);
    }
  }

  getPerformanceTier(): PerformanceTier {
    return this.tier;
  }

  getAudioLevels(): AudioLevels {
    return this.audio;
  }

  getFps(): number {
    return this.perf.fps();
  }

  /**
   * Test hook, not part of the supported surface: breaks the sky's aspect
   * correction on purpose so a visual test can prove it would notice.
   */
  debugForceSquareAspect(on: boolean): void {
    this.skyPass.forceSquareAspect = on;
    this.skyPass.resize(this.width, this.height);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    cancelAnimationFrame(this.frameHandle);

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.motionQuery?.removeEventListener('change', this.onMotionChange);
    this.motionQuery = null;

    this.micTap?.dispose();
    this.playbackTap?.dispose();
    this.micTap = null;
    this.playbackTap = null;
    void this.audioHolder.close();

    for (const pass of this.passes) pass.dispose();

    this.renderer.dispose();
    // Browsers cap how many live WebGL contexts a page may hold, so a scene
    // that is destroyed and recreated repeatedly must hand its context back
    // rather than wait for garbage collection.
    this.renderer.forceContextLoss();

    this.canvas.remove();
    this.liveRegion?.remove();
  }

  // --- internals ---------------------------------------------------------

  private swapTap(existing: AudioTap | null, source: AudioTapSource | null): AudioTap | null {
    existing?.dispose();
    if (!source || this.destroyed) return null;
    try {
      return createAudioTap(source, this.audioHolder);
    } catch (error) {
      // A failed tap must never take the scene down with it; the synthetic
      // envelope covers for it and the orb keeps moving.
      console.warn('[orb-engine] could not tap audio source:', error);
      return null;
    }
  }

  private createLiveRegion(): HTMLElement {
    const el = document.createElement('div');
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.className = 'orb-live-region';
    // Styled inline so the engine ships no stylesheet and, in particular, no
    // colour values: every colour in this repo lives in brand.ts.
    el.style.cssText =
      'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;' +
      'clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0;';
    this.container.appendChild(el);
    return el;
  }

  private announce(): void {
    if (this.liveRegion) this.liveRegion.textContent = STATE_TABLE[this.state].announcement;
  }

  private observeSize(): void {
    const apply = (): void => {
      const rect = this.container.getBoundingClientRect();
      this.width = Math.max(1, Math.round(rect.width));
      this.height = Math.max(1, Math.round(rect.height));
      this.renderer.setSize(this.width, this.height, false);
      for (const pass of this.passes) pass.resize(this.width, this.height);
    };
    apply();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(apply);
      this.resizeObserver.observe(this.container);
    }
  }

  private applyTier(tier: PerformanceTier, force = false): void {
    if (tier === this.tier && !force) return;
    this.tier = tier;
    const ratio = Math.min(TIER_PIXEL_RATIO[tier], this.maxPixelRatio, window.devicePixelRatio || 1);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(this.width, this.height, false);
    for (const pass of this.passes) {
      pass.setTier(tier);
      pass.resize(this.width, this.height);
    }
  }

  /** Read whichever stream the current state routes to, or stand in for it. */
  private sampleAudio(dt: number): AudioLevels {
    const route = STATE_TABLE[this.state].audioRoute;
    let raw = SILENCE;

    if (route === 'mic' && this.micTap) {
      raw = analyseBins(this.micTap.read());
    } else if (route === 'playback' && this.playbackTap) {
      raw = analyseBins(this.playbackTap.read(), PLAYBACK_BANDS);
    } else if (route !== 'none' && this.syntheticFallback) {
      raw = syntheticLevels(this.audioClock);
    }

    // Real time, not the reduced-motion clock: a voice does not slow down.
    this.audioClock += dt;
    return this.smoother.update(raw, dt);
  }

  private readonly frame = (nowMs: number): void => {
    if (this.destroyed) return;
    this.frameHandle = requestAnimationFrame(this.frame);

    const dt = clamp((nowMs - this.lastFrameMs) / 1000, 0, MAX_FRAME_SECONDS);
    this.lastFrameMs = nowMs;
    if (dt <= 0) return;

    if (this.perfMode === 'auto') {
      const tier = this.perf.sample(dt);
      if (tier !== this.tier) this.applyTier(tier);
    } else {
      this.perf.sample(dt);
    }

    stepParams(this.params, this.state, dt);
    this.audio = this.sampleAudio(dt);

    const route = STATE_TABLE[this.state].audioRoute;
    this.audioActive = approach(this.audioActive, route === 'none' ? 0 : 1, AUDIO_FADE_RATE, dt);

    this.animTime += dt * this.motionScale;
    this.noiseTime += dt * this.params.noiseSpeed * this.motionScale;

    const ctx: FrameContext = {
      dt: dt * this.motionScale,
      animTime: this.animTime,
      noiseTime: this.noiseTime,
      params: this.params,
      audio: this.audio,
      color: cycledColor(this.params, this.animTime),
      activity: activityLevel(this.params, this.audio, this.animTime),
      audioActive: this.audioActive,
      tier: this.tier,
    };

    this.renderer.clear(true, true, true);
    for (const pass of this.passes) {
      pass.update(ctx);
      if (pass.clearDepthBefore) this.renderer.clearDepth();
      pass.render(this.renderer);
    }
  };
}

/** How fast the high noise octave fades in and out with the audio route. */
const AUDIO_FADE_RATE = rateFromPerFrame(0.04);

/**
 * Mount a scene into `container`, which must be positioned and sized by CSS.
 *
 * The engine owns one WebGL context and one animation loop. It never reaches
 * for a backend: states and audio come in through the returned handle.
 */
export function createOrbScene(
  container: HTMLElement,
  options: OrbSceneOptions = {},
): OrbSceneHandle {
  return new OrbEngine(container, options);
}
