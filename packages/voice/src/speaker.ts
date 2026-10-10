import { chunkText } from './chunk.js';
import type { AudioSink, SpeakerScene, VoiceProvider } from './types.js';

export interface SpeakerOptions {
  readonly scene: SpeakerScene;
  readonly provider: VoiceProvider;
  /** Required for providers that return real audio. */
  readonly sink?: AudioSink;
  /** How long the error state is held before returning to idle. 0 holds it. */
  readonly errorHoldMs?: number;
  /** Called as each piece begins, for captions or logging. */
  readonly onChunk?: (text: string, index: number, total: number) => void;
  readonly onError?: (error: Error) => void;
  /** Injectable for tests. */
  readonly wait?: (ms: number) => Promise<void>;
}

export interface Speaker {
  /** Say something. Resolves when the last piece has finished. */
  speak(text: string): Promise<void>;
  /** Stop at once and return the orb to idle. */
  stop(): void;
  /** Swap the voice. Anything in flight is stopped first. */
  setProvider(provider: VoiceProvider): void;
  readonly provider: VoiceProvider;
  readonly speaking: boolean;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Drives the orb from a voice.
 *
 * The state sequence is the point of this module:
 *
 *   thinking  while the words are being prepared — a real network round trip
 *             and decode for Deepgram, a moment's voice lookup for the browser
 *   speaking  from the first sample heard to the last
 *   idle      afterwards
 *
 * A short thinking phase is not a glitch, because every parameter in the
 * scene eases over about a second: a 50ms stay reads as the colour leaning
 * toward violet and back, not as a flash.
 *
 * Kept free of WebGL and Web Audio so the sequence can be tested against a
 * fake scene and a fake provider, which is where the bugs in something like
 * this actually live.
 */
export function createSpeaker(options: SpeakerOptions): Speaker {
  const { scene } = options;
  const errorHoldMs = options.errorHoldMs ?? 2500;
  const wait = options.wait ?? sleep;

  let provider = options.provider;
  let controller: AbortController | null = null;
  let speaking = false;

  const stop = (): void => {
    controller?.abort();
    controller = null;
    provider.cancel();
    options.sink?.attach(null);
    speaking = false;
  };

  return {
    get provider() {
      return provider;
    },
    get speaking() {
      return speaking;
    },

    setProvider(next: VoiceProvider): void {
      if (next === provider) return;
      stop();
      scene.setState('idle');
      provider = next;
    },

    async speak(text: string): Promise<void> {
      const pieces = chunkText(text, provider.maxChars);
      if (pieces.length === 0) return;

      // A second request supersedes the first rather than overlapping it.
      stop();

      const own = new AbortController();
      controller = own;
      speaking = true;
      scene.setState('processing');

      let started = false;
      const markStarted = (): void => {
        if (started || own.signal.aborted) return;
        started = true;
        scene.setState('speaking');
      };

      try {
        for (const [index, piece] of pieces.entries()) {
          if (own.signal.aborted) return;
          options.onChunk?.(piece, index, pieces.length);
          await provider.speak(piece, {
            signal: own.signal,
            ...(options.sink ? { sink: options.sink } : {}),
            onAudioStart: markStarted,
          });
        }
        if (!own.signal.aborted) scene.setState('idle');
      } catch (error) {
        if (own.signal.aborted) return;
        const failure = error instanceof Error ? error : new Error(String(error));
        options.onError?.(failure);
        scene.setState('error');
        if (errorHoldMs > 0) {
          await wait(errorHoldMs);
          // Only stand down if nothing else has taken the scene somewhere else.
          if (!own.signal.aborted && scene.getState() === 'error') scene.setState('idle');
        }
        throw failure;
      } finally {
        if (controller === own) {
          controller = null;
          speaking = false;
          options.sink?.attach(null);
        }
      }
    },

    stop(): void {
      stop();
      scene.setState('idle');
    },
  };
}

/** Build an {@link AudioSink} from the orb's handle. */
export function createSceneSink(scene: {
  getAudioContext(): AudioContext;
  setPlaybackSource(node: AudioNode | null): void;
}): AudioSink {
  return {
    context: () => scene.getAudioContext(),
    attach: (node) => scene.setPlaybackSource(node),
  };
}
