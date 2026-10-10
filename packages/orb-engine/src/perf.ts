import type { PerformanceTier } from './types.js';

/**
 * Frame-rate watchdog.
 *
 * Decides, from elapsed frame times alone, whether the scene should drop to
 * the cheaper tier. Pure: it owns no timers and touches no WebGL, so the
 * decision rule is unit-testable by feeding it synthetic frame times.
 *
 * The drop latches. A scene that downgrades becomes cheaper, which raises the
 * frame rate, which would immediately argue for upgrading again — that is a
 * loop that visibly flaps. So once we go low, we stay low.
 */
export interface PerfMonitorOptions {
  /** Frame rate below which the scene is considered to be struggling. */
  readonly thresholdFps?: number;
  /** How long it must stay below the threshold before dropping, in seconds. */
  readonly sustainSeconds?: number;
  /** Frames to ignore at startup, while shaders compile and caches warm. */
  readonly warmupFrames?: number;
  /**
   * Longest gap still treated as a frame, in seconds.
   *
   * A backgrounded tab, a garbage collection pause or a modal dialog produce
   * gaps of seconds. Those are stalls, not a frame rate: counted as frames
   * they would both wreck the average and trip the watchdog instantly on the
   * first frame after the tab comes back.
   */
  readonly maxCredibleSeconds?: number;
}

export interface PerfMonitor {
  /** Feed one frame's duration in seconds. Returns the tier to render at. */
  sample(dt: number): PerformanceTier;
  /** Frames per second, averaged over roughly the last second. */
  fps(): number;
  /** The tier currently in force. */
  tier(): PerformanceTier;
  /** Forget everything, including the latch. */
  reset(): void;
}

export function createPerfMonitor(options: PerfMonitorOptions = {}): PerfMonitor {
  const thresholdFps = options.thresholdFps ?? 45;
  const sustainSeconds = options.sustainSeconds ?? 3;
  const warmupFrames = options.warmupFrames ?? 30;
  const maxCredibleSeconds = options.maxCredibleSeconds ?? 0.5;

  let frames = 0;
  /** Seconds spent continuously below the threshold. */
  let belowFor = 0;
  let latchedLow = false;
  /** Exponentially weighted mean frame time, in seconds. */
  let meanDt = 1 / 60;

  return {
    sample(dt: number): PerformanceTier {
      if (!(dt > 0) || !Number.isFinite(dt) || dt > maxCredibleSeconds) {
        return latchedLow ? 'low' : 'high';
      }
      frames += 1;
      // Roughly a one-second window: weight ~ dt / 1s, capped so a single
      // enormous hitch cannot throw the average away entirely.
      const w = Math.min(0.5, dt);
      meanDt += (dt - meanDt) * w;

      if (latchedLow || frames <= warmupFrames) {
        return latchedLow ? 'low' : 'high';
      }

      const instantaneousFps = 1 / dt;
      if (instantaneousFps < thresholdFps) {
        belowFor += dt;
        if (belowFor >= sustainSeconds) latchedLow = true;
      } else {
        // One good frame is not recovery, but a run of them is: decay the
        // accumulated debt rather than zeroing it, so an alternating
        // good/bad pattern still eventually trips.
        belowFor = Math.max(0, belowFor - dt * 2);
      }
      return latchedLow ? 'low' : 'high';
    },
    fps: () => (meanDt > 0 ? 1 / meanDt : 0),
    tier: () => (latchedLow ? 'low' : 'high'),
    reset: () => {
      frames = 0;
      belowFor = 0;
      latchedLow = false;
      meanDt = 1 / 60;
    },
  };
}
