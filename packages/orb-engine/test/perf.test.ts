import { describe, expect, it } from 'vitest';
import { createPerfMonitor } from '../src/perf.js';

/** Feed `seconds` worth of frames at a steady rate. */
function run(monitor: ReturnType<typeof createPerfMonitor>, fps: number, seconds: number) {
  const dt = 1 / fps;
  let tier = monitor.tier();
  for (let t = 0; t < seconds; t += dt) tier = monitor.sample(dt);
  return tier;
}

describe('createPerfMonitor', () => {
  it('stays high while the frame rate is healthy', () => {
    const monitor = createPerfMonitor();
    expect(run(monitor, 60, 20)).toBe('high');
    expect(monitor.fps()).toBeGreaterThan(55);
  });

  it('drops after three sustained seconds below the threshold', () => {
    const monitor = createPerfMonitor({ thresholdFps: 45, sustainSeconds: 3, warmupFrames: 0 });
    // Two seconds of struggle is not enough.
    expect(run(monitor, 30, 2)).toBe('high');
    // Carrying on past three is.
    expect(run(monitor, 30, 1.5)).toBe('low');
  });

  it('ignores the first frames while shaders compile and caches warm', () => {
    const monitor = createPerfMonitor({ warmupFrames: 30, sustainSeconds: 0.2 });
    // A terrible first second must not condemn the scene.
    run(monitor, 5, 1);
    expect(monitor.tier()).toBe('high');
  });

  it('never flaps back once it has dropped', () => {
    const monitor = createPerfMonitor({ warmupFrames: 0 });
    run(monitor, 20, 4);
    expect(monitor.tier()).toBe('low');
    // The cheaper scene runs fast again, which is exactly the argument for
    // upgrading — and exactly the loop that would make it visibly oscillate.
    expect(run(monitor, 144, 30)).toBe('low');
  });

  it('tolerates an occasional hitch without dropping', () => {
    const monitor = createPerfMonitor({ warmupFrames: 0 });
    for (let i = 0; i < 600; i += 1) {
      // A quarter-second stall every two seconds, otherwise a smooth 60.
      monitor.sample(i % 120 === 0 ? 0.25 : 1 / 60);
    }
    expect(monitor.tier()).toBe('high');
  });

  it('still trips when good and bad frames alternate', () => {
    const monitor = createPerfMonitor({ warmupFrames: 0, sustainSeconds: 3 });
    // Alternating 25fps and 60fps averages out below the threshold; a rule
    // that zeroed the debt on any good frame would never notice.
    for (let i = 0; i < 2000; i += 1) monitor.sample(i % 2 === 0 ? 1 / 25 : 1 / 60);
    expect(monitor.tier()).toBe('low');
  });

  it('reports a sane frame rate', () => {
    const monitor = createPerfMonitor();
    run(monitor, 30, 10);
    expect(monitor.fps()).toBeGreaterThan(25);
    expect(monitor.fps()).toBeLessThan(35);
  });

  it('ignores nonsense frame times rather than poisoning the average', () => {
    const monitor = createPerfMonitor({ warmupFrames: 0 });
    run(monitor, 60, 5);
    const before = monitor.fps();
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(monitor.sample(bad)).toBe('high');
    }
    expect(monitor.fps()).toBeCloseTo(before, 6);
  });

  it('treats a multi-second gap as a stall, not as a frame rate', () => {
    const monitor = createPerfMonitor({ warmupFrames: 0, sustainSeconds: 3 });
    run(monitor, 60, 5);
    const before = monitor.fps();

    // A backgrounded tab coming back. Counted as a frame this would both
    // ruin the average and trip the watchdog on the spot.
    expect(monitor.sample(45)).toBe('high');
    expect(monitor.tier()).toBe('high');
    expect(monitor.fps()).toBeCloseTo(before, 6);

    // And the scene is still judged on the frames that follow.
    expect(run(monitor, 60, 5)).toBe('high');
  });

  it('reports a frame rate below ten rather than flooring it', () => {
    const monitor = createPerfMonitor({ warmupFrames: 0 });
    run(monitor, 3, 12);
    expect(monitor.fps()).toBeGreaterThan(2);
    expect(monitor.fps()).toBeLessThan(5);
    expect(monitor.tier()).toBe('low');
  });

  it('forgets everything on reset, including the latch', () => {
    const monitor = createPerfMonitor({ warmupFrames: 0 });
    run(monitor, 20, 5);
    expect(monitor.tier()).toBe('low');
    monitor.reset();
    expect(monitor.tier()).toBe('high');
    expect(run(monitor, 60, 10)).toBe('high');
  });
});
