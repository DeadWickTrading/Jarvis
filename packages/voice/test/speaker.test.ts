import { describe, expect, it, vi } from 'vitest';
import { createSpeaker } from '../src/speaker.js';
import type { SpeakOptions, VoiceProvider } from '../src/types.js';
import type { OrbState } from '@deadwick/orb-engine';

/** A scene that only records what it was told. */
function fakeScene() {
  const states: OrbState[] = ['idle'];
  return {
    states,
    setState(state: OrbState) {
      states.push(state);
    },
    getState: () => states[states.length - 1]!,
  };
}

interface FakeOptions {
  maxChars?: number;
  /** Milliseconds of "network and decode" before sound starts. */
  startDelay?: number;
  failOn?: number;
}

function fakeProvider(options: FakeOptions = {}) {
  const spoken: string[] = [];
  let cancelled = 0;

  const provider: VoiceProvider = {
    id: 'fake',
    label: 'Fake',
    providesAudioStream: true,
    maxChars: options.maxChars ?? 1000,
    available: async () => ({ ok: true }),
    async speak(text: string, { signal, onAudioStart }: SpeakOptions) {
      if (options.failOn !== undefined && spoken.length === options.failOn) {
        throw new Error('upstream exploded');
      }
      spoken.push(text);
      if (options.startDelay) {
        await new Promise((resolve) => setTimeout(resolve, options.startDelay));
      }
      if (signal?.aborted) return;
      onAudioStart?.();
    },
    cancel() {
      cancelled += 1;
    },
  };

  return {
    provider,
    spoken,
    get cancelled() {
      return cancelled;
    },
  };
}

describe('createSpeaker', () => {
  it('goes thinking, then speaking, then idle', async () => {
    const scene = fakeScene();
    const { provider } = fakeProvider({ startDelay: 5 });
    const speaker = createSpeaker({ scene, provider });

    await speaker.speak('Good day, sir.');

    expect(scene.states).toEqual(['idle', 'processing', 'speaking', 'idle']);
  });

  it('only leaves thinking once sound actually starts', async () => {
    const scene = fakeScene();
    const { provider } = fakeProvider({ startDelay: 40 });
    const speaker = createSpeaker({ scene, provider });

    const done = speaker.speak('Jarwick online.');
    // Mid-flight: the request is out but nothing is audible yet.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(scene.getState()).toBe('processing');

    await done;
    expect(scene.getState()).toBe('idle');
  });

  it('enters speaking exactly once across several chunks', async () => {
    const scene = fakeScene();
    const { provider, spoken } = fakeProvider({ maxChars: 20 });
    const speaker = createSpeaker({ scene, provider });

    await speaker.speak('One two three. Four five six. Seven eight nine.');

    expect(spoken.length).toBeGreaterThan(1);
    expect(scene.states.filter((s) => s === 'speaking')).toHaveLength(1);
    expect(scene.states.at(-1)).toBe('idle');
  });

  it('says nothing, and changes nothing, for empty text', async () => {
    const scene = fakeScene();
    const { provider, spoken } = fakeProvider();
    const speaker = createSpeaker({ scene, provider });

    await speaker.speak('   ');

    expect(spoken).toEqual([]);
    expect(scene.states).toEqual(['idle']);
  });

  it('shows the error state and then stands down', async () => {
    const scene = fakeScene();
    const { provider } = fakeProvider({ failOn: 0 });
    const onError = vi.fn();
    const speaker = createSpeaker({
      scene,
      provider,
      onError,
      errorHoldMs: 10,
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    });

    await expect(speaker.speak('This will fail.')).rejects.toThrow(/exploded/);

    expect(onError).toHaveBeenCalledOnce();
    expect(scene.states).toContain('error');
    expect(scene.states.at(-1)).toBe('idle');
  });

  it('holds the error state when asked to', async () => {
    const scene = fakeScene();
    const { provider } = fakeProvider({ failOn: 0 });
    const speaker = createSpeaker({ scene, provider, errorHoldMs: 0 });

    await expect(speaker.speak('Nope.')).rejects.toThrow();
    expect(scene.getState()).toBe('error');
  });

  it('does not stand down from an error the caller has already moved on from', async () => {
    const scene = fakeScene();
    const { provider } = fakeProvider({ failOn: 0 });
    const speaker = createSpeaker({
      scene,
      provider,
      errorHoldMs: 20,
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    });

    const failing = speaker.speak('Nope.').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Something else takes over while the error is being held.
    scene.setState('listening');
    await failing;

    expect(scene.getState()).toBe('listening');
  });

  it('stops on request and returns the orb to idle', async () => {
    const scene = fakeScene();
    const fake = fakeProvider({ startDelay: 200 });
    const speaker = createSpeaker({ scene, provider: fake.provider });

    const inFlight = speaker.speak('A long sentence that will be interrupted.');
    await new Promise((resolve) => setTimeout(resolve, 20));
    speaker.stop();
    await inFlight;

    expect(fake.cancelled).toBeGreaterThan(0);
    expect(scene.getState()).toBe('idle');
    expect(speaker.speaking).toBe(false);
  });

  it('lets a second request supersede the first rather than overlapping', async () => {
    const scene = fakeScene();
    const fake = fakeProvider({ startDelay: 80 });
    const speaker = createSpeaker({ scene, provider: fake.provider });

    const first = speaker.speak('First thing.');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = speaker.speak('Second thing.');
    await Promise.all([first, second]);

    expect(fake.cancelled).toBeGreaterThan(0);
    expect(scene.getState()).toBe('idle');
  });

  it('reports each chunk as it begins', async () => {
    const scene = fakeScene();
    const { provider } = fakeProvider({ maxChars: 16 });
    const onChunk = vi.fn();
    const speaker = createSpeaker({ scene, provider, onChunk });

    await speaker.speak('Alpha beta. Gamma delta. Epsilon zeta.');

    expect(onChunk.mock.calls.length).toBeGreaterThan(1);
    const [, index, total] = onChunk.mock.calls[0]!;
    expect(index).toBe(0);
    expect(total).toBe(onChunk.mock.calls.length);
  });

  it('detaches the audio tap when it finishes, so the orb stops riding stale audio', async () => {
    const scene = fakeScene();
    const { provider } = fakeProvider();
    const attached: (AudioNode | null)[] = [];
    const sink = {
      context: () => ({}) as AudioContext,
      attach: (node: AudioNode | null) => attached.push(node),
    };

    const speaker = createSpeaker({ scene, provider, sink });
    await speaker.speak('Anything.');

    expect(attached.at(-1)).toBeNull();
  });

  it('swaps provider without leaving the orb mid-sentence', async () => {
    const scene = fakeScene();
    const first = fakeProvider({ startDelay: 200 });
    const second = fakeProvider();
    const speaker = createSpeaker({ scene, provider: first.provider });

    const inFlight = speaker.speak('Interrupted by a voice change.');
    await new Promise((resolve) => setTimeout(resolve, 20));
    speaker.setProvider(second.provider);
    await inFlight;

    expect(first.cancelled).toBeGreaterThan(0);
    expect(speaker.provider).toBe(second.provider);
    expect(scene.getState()).toBe('idle');
  });
});
