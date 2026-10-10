import { createOrbScene, ORB_STATES, STATE_TABLE, syntheticLevels } from '@deadwick/orb-engine';
import type { OrbSceneHandle, OrbState, PerformanceMode } from '@deadwick/orb-engine';

const container = document.querySelector<HTMLElement>('#scene');
if (!container) throw new Error('#scene container is missing from the page');

/**
 * Query flags, so the headless screenshot harness can pin the scene without
 * the demo needing a separate entry point:
 *
 *   ?perf=high|low|auto   force a rendering tier
 *   ?seed=<int>           choose the galaxy layout
 *   ?motion=full          ignore the OS reduce-motion setting
 *   ?audio=off            disable the synthetic voice fallback
 *   ?ui=off               hide the demo chrome, leaving only the scene
 */
const query = new URLSearchParams(location.search);
const perfParam = query.get('perf');
const initialPerf: PerformanceMode =
  perfParam === 'high' || perfParam === 'low' || perfParam === 'auto' ? perfParam : 'auto';
const seedParam = Number(query.get('seed'));

// Hiding the chrome matters for the visual tests: UI glyphs are bright,
// elongated and scattered across the frame, which is indistinguishable from
// stretched stars to a measurement that works on bright blobs.
if (query.get('ui') === 'off') document.body.classList.add('scene-only');

function buildScene(initialState: OrbState = 'idle'): OrbSceneHandle {
  return createOrbScene(container!, {
    initialState,
    performanceMode: initialPerf,
    respectReducedMotion: query.get('motion') !== 'full',
    syntheticAudioFallback: query.get('audio') !== 'off',
    ...(Number.isFinite(seedParam) && seedParam !== 0 ? { seed: seedParam } : {}),
  });
}

let scene: OrbSceneHandle = buildScene();

// --- element lookup ----------------------------------------------------------

const need = <T extends Element>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`demo: missing element ${selector}`);
  return el;
};

const stateLabel = need<HTMLElement>('#state-label');
const tierLabel = need<HTMLElement>('#tier-label');
const fpsLabel = need<HTMLElement>('#fps-label');
const meter = need<HTMLElement>('#meter');
const micButton = need<HTMLButtonElement>('#mic-button');
const toneButton = need<HTMLButtonElement>('#tone-button');
const stateButtons = [...document.querySelectorAll<HTMLButtonElement>('button[data-state]')];
const perfButtons = [...document.querySelectorAll<HTMLButtonElement>('button[data-perf]')];

// --- state ------------------------------------------------------------------

/** Reflect a state change into the chips and the readout. */
function showState(state: OrbState): void {
  for (const button of stateButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.state === state));
  }
  stateLabel.textContent = STATE_TABLE[state].announcement;
  // The readout and the level meter wear the state's own colour. CSS owns the
  // values; this only repoints the alias.
  document.documentElement.style.setProperty('--dw-state', `var(--dw-state-${state})`);
}

function setState(state: OrbState): void {
  scene.setState(state);
  showState(state);
}

for (const button of stateButtons) {
  button.addEventListener('click', () => {
    const state = button.dataset.state as OrbState | undefined;
    if (state && (ORB_STATES as readonly string[]).includes(state)) setState(state);
  });
}

for (const button of perfButtons) {
  button.addEventListener('click', () => {
    const mode = button.dataset.perf as PerformanceMode | undefined;
    if (!mode) return;
    scene.setPerformanceMode(mode);
    for (const other of perfButtons) {
      other.setAttribute('aria-pressed', String(other === button));
    }
  });
}

// --- microphone --------------------------------------------------------------

let micStream: MediaStream | null = null;

/**
 * The honest arming flow.
 *
 * `arming` goes up *before* the permission prompt and stays up for as long as
 * the request is outstanding, so what the user sees matches what is true: the
 * mic has been asked for and nothing is arriving yet. Only once a live stream
 * exists does the warm recording light come on.
 */
async function startMic(): Promise<void> {
  setState('arming');
  micButton.setAttribute('aria-pressed', 'true');
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    scene.setMicSource(micStream);
    setState('listening');
  } catch (error) {
    console.warn('[demo] microphone unavailable:', error);
    micButton.setAttribute('aria-pressed', 'false');
    setState('error');
  }
}

function stopMic(): void {
  scene.setMicSource(null);
  for (const track of micStream?.getTracks() ?? []) track.stop();
  micStream = null;
  micButton.setAttribute('aria-pressed', 'false');
  if (scene.getState() === 'listening' || scene.getState() === 'arming') setState('idle');
}

micButton.addEventListener('click', () => {
  if (micStream) stopMic();
  else void startMic();
});

// --- test tone ---------------------------------------------------------------

const TONE_SECONDS = 7;
let toneTimer: number | null = null;

/**
 * A short synthesised utterance, used to show the galaxy answering real
 * playback audio rather than the synthetic fallback.
 *
 * Two detuned oscillators through a lowpass stand in for a voice's harmonics,
 * and the amplitude follows the engine's own synthetic speech envelope — so
 * what the analyser hears has the shape of speech, with syllables and pauses,
 * instead of a flat tone that would make the orb sit at a constant size.
 *
 * Built in the engine's own AudioContext. Web Audio cannot connect nodes
 * across contexts, so a node made in a context of our own would be rejected
 * at the tap.
 */
function playTestTone(): void {
  const ctx = scene.getAudioContext();
  void ctx.resume();

  const fundamental = ctx.createOscillator();
  fundamental.type = 'sawtooth';
  fundamental.frequency.value = 126;

  const overtone = ctx.createOscillator();
  overtone.type = 'triangle';
  overtone.frequency.value = 193;

  const formant = ctx.createBiquadFilter();
  formant.type = 'lowpass';
  formant.frequency.value = 1750;
  formant.Q.value = 0.9;

  const gain = ctx.createGain();
  gain.gain.value = 0;

  fundamental.connect(formant);
  overtone.connect(formant);
  formant.connect(gain);
  gain.connect(ctx.destination);

  const steps = TONE_SECONDS * 60;
  const envelope = new Float32Array(steps);
  for (let i = 0; i < steps; i += 1) {
    // Quiet enough to live with; the orb reads the shape, not the volume.
    envelope[i] = syntheticLevels(i / 60).level * 0.09;
  }
  gain.gain.setValueCurveAtTime(envelope, ctx.currentTime, TONE_SECONDS);

  fundamental.start();
  overtone.start();
  fundamental.stop(ctx.currentTime + TONE_SECONDS);
  overtone.stop(ctx.currentTime + TONE_SECONDS);

  // Tap the gain node, which is an ordinary fan-out: the path to the speakers
  // is untouched and the tone is heard exactly as it would be anyway.
  scene.setPlaybackSource(gain);
  setState('speaking');
  toneButton.setAttribute('aria-pressed', 'true');

  if (toneTimer !== null) clearTimeout(toneTimer);
  toneTimer = window.setTimeout(() => {
    scene.setPlaybackSource(null);
    toneButton.setAttribute('aria-pressed', 'false');
    if (scene.getState() === 'speaking') setState('idle');
    toneTimer = null;
  }, TONE_SECONDS * 1000);
}

toneButton.addEventListener('click', playTestTone);

// --- keyboard ----------------------------------------------------------------

document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const index = Number(event.key) - 1;
  if (Number.isInteger(index) && index >= 0 && index < ORB_STATES.length) {
    setState(ORB_STATES[index]!);
    return;
  }
  if (event.key.toLowerCase() === 'm') micButton.click();
  if (event.key.toLowerCase() === 't') toneButton.click();
});

// --- readout -----------------------------------------------------------------

let readoutHandle = requestAnimationFrame(function tick() {
  readoutHandle = requestAnimationFrame(tick);
  const { level } = scene.getAudioLevels();
  meter.style.width = `${Math.round(level * 100)}%`;
  fpsLabel.textContent = String(Math.round(scene.getFps()));
  tierLabel.textContent = scene.getPerformanceTier();
});

showState(scene.getState());

/**
 * Tear the scene down and build a new one in its place.
 *
 * Exposed for the visual tests, which do this many times over to prove the
 * teardown really releases everything. Browsers cap how many live WebGL
 * contexts a page may hold — around sixteen — so a leak shows up as the
 * browser dropping older contexts and the scene going blank, rather than as
 * an exception anyone would notice.
 */
function recreateScene(): void {
  const state = scene.getState();
  scene.destroy();
  scene = buildScene(state);
  if (micStream) scene.setMicSource(micStream);
  showState(state);
  Object.assign(window, { scene });
}

// Exposed so the screenshot harness and manual poking can drive the scene.
Object.assign(window, { scene, recreateScene });

window.addEventListener('beforeunload', () => {
  cancelAnimationFrame(readoutHandle);
  stopMic();
  if (toneTimer !== null) clearTimeout(toneTimer);
  // The engine owns its AudioContext and closes it on destroy.
  scene.destroy();
});
