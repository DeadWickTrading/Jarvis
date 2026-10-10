import { createOrbScene } from '@deadwick/orb-engine';
import type { OrbSceneHandle, PerformanceMode } from '@deadwick/orb-engine';

const container = document.querySelector<HTMLElement>('#scene');
if (!container) throw new Error('#scene container is missing from the page');

/**
 * Query flags, so the headless screenshot harness can pin the scene without
 * the demo needing a separate entry point:
 *
 *   ?perf=high|low|auto   force a rendering tier
 *   ?seed=<int>           choose the galaxy layout
 *   ?motion=full          ignore the OS reduce-motion setting
 */
const query = new URLSearchParams(location.search);
const perfParam = query.get('perf');
const performanceMode: PerformanceMode =
  perfParam === 'high' || perfParam === 'low' || perfParam === 'auto' ? perfParam : 'auto';
const seedParam = Number(query.get('seed'));

const scene: OrbSceneHandle = createOrbScene(container, {
  initialState: 'idle',
  performanceMode,
  respectReducedMotion: query.get('motion') !== 'full',
  ...(Number.isFinite(seedParam) && seedParam !== 0 ? { seed: seedParam } : {}),
});

// Exposed so the screenshot harness and manual poking can drive the scene.
Object.assign(window, { scene });

window.addEventListener('beforeunload', () => scene.destroy());
