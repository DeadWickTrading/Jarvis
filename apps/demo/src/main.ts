import { createOrbScene, ORB_STATES, STATE_TABLE, syntheticLevels } from '@deadwick/orb-engine';
import type { OrbSceneHandle, OrbState, PerformanceMode } from '@deadwick/orb-engine';
import {
  createBrowserVoice,
  createDeepgramVoice,
  createElevenLabsVoice,
  createSceneSink,
  createSpeaker,
  createVoiceAgent,
} from '@deadwick/voice';
import type { Speaker, VoiceAgent, VoiceAvailability, VoiceProvider } from '@deadwick/voice';
import { JARWICK_AGENT_SETTINGS } from './agent-settings.js';

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
 *   ?agent=<ws url>       point the Voice Agent at a different socket, which
 *                         is how the stub agent is exercised without Deepgram
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
    // ?shape=orb brings back the sphere; the candle is the default look.
    shape: query.get('shape') === 'orb' ? 'orb' : 'wick',
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
const sayForm = need<HTMLFormElement>('#say-form');
const sayText = need<HTMLInputElement>('#say-text');
const sayButton = need<HTMLButtonElement>('#say-button');
const stopButton = need<HTMLButtonElement>('#stop-button');
const voiceSelect = need<HTMLSelectElement>('#voice-select');
const voiceStatus = need<HTMLElement>('#voice-status');
const talkButton = need<HTMLButtonElement>('#talk-button');
const endButton = need<HTMLButtonElement>('#end-button');
const transcript = need<HTMLElement>('#transcript');

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

// --- speech ------------------------------------------------------------------

/**
 * The three ways Jarwick can talk.
 *
 * None of them names a model here on purpose. The server chooses, from
 * DEEPGRAM_TTS_MODEL and ELEVENLABS_VOICE_ID, so changing the voice is an
 * environment variable and a restart rather than an edit and a rebuild. The
 * health endpoint reports what it settled on, and the UI shows it.
 */
const providers: VoiceProvider[] = [
  createBrowserVoice(),
  createDeepgramVoice(),
  createElevenLabsVoice(),
];

const speaker: Speaker = createSpeaker({
  scene: {
    setState: (state) => setState(state),
    getState: () => scene.getState(),
  },
  provider: providers[0]!,
  sink: createSceneSink({
    getAudioContext: () => scene.getAudioContext(),
    setPlaybackSource: (node) => scene.setPlaybackSource(node),
  }),
  onError: (error) => showVoiceStatus(error.message, 'error'),
});

function showVoiceStatus(message: string, tone: 'info' | 'warn' | 'error' = 'info'): void {
  voiceStatus.textContent = message;
  voiceStatus.dataset.tone = tone;
}

interface VoiceOption {
  readonly provider: VoiceProvider;
  readonly availability: VoiceAvailability;
}

let voiceOptions: VoiceOption[] = [];

/** Ask each provider whether it can work, and say so honestly in the UI. */
async function probeVoices(): Promise<void> {
  voiceSelect.replaceChildren();

  const results: VoiceOption[] = await Promise.all(
    providers.map(async (provider) => ({
      provider,
      availability: await provider
        .available()
        .catch((error: Error): VoiceAvailability => ({ ok: false, reason: error.message })),
    })),
  );

  for (const { provider, availability } of results) {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = availability.ok
      ? provider.label
      : `${provider.label} — unavailable`;
    option.disabled = !availability.ok;
    option.title = availability.ok ? (availability.detail ?? '') : (availability.reason ?? '');
    voiceSelect.append(option);
  }

  voiceOptions = results;

  // Prefer a provider whose audio the orb can actually tap; fall back to the
  // first that works at all.
  const best =
    results.find((r) => r.availability.ok && r.provider.providesAudioStream) ??
    results.find((r) => r.availability.ok);

  if (!best) {
    showVoiceStatus(
      results.map((r) => `${r.provider.label}: ${r.availability.reason}`).join('  ·  '),
      'error',
    );
    sayButton.disabled = true;
    return;
  }

  voiceSelect.value = best.provider.id;
  selectVoice(best.provider.id);
}

function selectVoice(id: string): void {
  const found = voiceOptions.find((r) => r.provider.id === id);
  if (!found) return;

  speaker.setProvider(found.provider);
  sayButton.disabled = false;

  const detail = found.availability.detail ?? found.provider.label;
  // Say plainly whether the orb is riding the real waveform. Browser speech
  // exposes no audio stream at any point, so the motion there is the engine's
  // synthetic envelope: convincing, but unrelated to the words.
  const motion = found.provider.providesAudioStream
    ? 'orb rides the real waveform'
    : 'orb motion is synthetic — browser speech exposes no audio stream';
  showVoiceStatus(
    `${detail} · ${motion}`,
    found.provider.providesAudioStream ? 'info' : 'warn',
  );
}

voiceSelect.addEventListener('change', () => selectVoice(voiceSelect.value));

sayForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = sayText.value.trim();
  if (text.length === 0) return;
  void speaker.speak(text).catch(() => {
    // createSpeaker has already shown the error and moved the orb; nothing
    // further to do here.
  });
});

stopButton.addEventListener('click', () => speaker.stop());

void probeVoices();

// --- the conversation ---------------------------------------------------------

/**
 * The Voice Agent: listen, think and speak over one socket.
 *
 * The microphone is a latch, not a hold. Press Talk and it stays on through
 * as many exchanges as you like; press it again and the capture stops and the
 * media tracks are released, so the browser's recording indicator goes out
 * rather than staying lit over a promise that nothing is listening.
 *
 * The socket stays open in between, kept alive, so switching back on is
 * instant and Jarwick keeps the thread of the conversation. End closes it.
 */
const sceneSink = createSceneSink({
  getAudioContext: () => scene.getAudioContext(),
  setPlaybackSource: (node) => scene.setPlaybackSource(node),
});

const agentUrlOverride = query.get('agent');

// Settings with Henrik's HQ snapshot in the prompt, when the HQ bridge is
// running; the static persona otherwise.
const agentSettings: Record<string, unknown> = await fetch('/api/hq/agent-settings')
  .then((r) => (r.ok ? (r.json() as Promise<Record<string, unknown>>) : JARWICK_AGENT_SETTINGS))
  .catch(() => JARWICK_AGENT_SETTINGS);

const agent: VoiceAgent = createVoiceAgent({
  scene: {
    setState: (state) => setState(state),
    getState: () => scene.getState(),
  },
  sink: sceneSink,
  settings: agentSettings,
  ...(agentUrlOverride ? { url: agentUrlOverride } : {}),
  onStatus: (status) => {
    talkButton.setAttribute('aria-pressed', String(status.micOpen));
    talkButton.textContent = status.micArming
      ? 'Opening…'
      : status.micOpen
        ? 'Listening'
        : 'Talk';
    endButton.disabled = status.connection === 'closed';
  },
  onTranscript: (role, text) => {
    transcript.dataset.role = role;
    transcript.replaceChildren();
    const label = document.createElement('b');
    label.textContent = role === 'user' ? 'You' : 'Jarwick';
    transcript.append(label, document.createTextNode(text));
  },
  onInfo: (message) => showVoiceStatus(message),
  onError: (error) => showVoiceStatus(error.message, 'error'),
});

talkButton.addEventListener('click', () => {
  void agent.toggleMic().catch((error: Error) => showVoiceStatus(error.message, 'error'));
});

endButton.addEventListener('click', () => {
  agent.end();
  transcript.replaceChildren();
  showVoiceStatus('Conversation ended.');
});
endButton.disabled = true;

// --- keyboard ----------------------------------------------------------------

document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  // Typing into the say bar must not trigger scene shortcuts.
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
  const index = Number(event.key) - 1;
  if (Number.isInteger(index) && index >= 0 && index < ORB_STATES.length) {
    setState(ORB_STATES[index]!);
    return;
  }
  if (event.key.toLowerCase() === 'm') micButton.click();
  if (event.key.toLowerCase() === 't') toneButton.click();
  // Space is the natural key for a talk latch, and it must not also scroll.
  if (event.code === 'Space') {
    event.preventDefault();
    talkButton.click();
  }
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
Object.assign(window, { scene, recreateScene, speaker, agent });

window.addEventListener('beforeunload', () => {
  cancelAnimationFrame(readoutHandle);
  agent.end();
  speaker.stop();
  for (const provider of providers) provider.dispose?.();
  stopMic();
  if (toneTimer !== null) clearTimeout(toneTimer);
  // The engine owns its AudioContext and closes it on destroy.
  scene.destroy();
});
