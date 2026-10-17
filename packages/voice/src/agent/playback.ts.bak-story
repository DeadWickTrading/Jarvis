import { decodePcm16 } from './pcm.js';

export interface PcmPlayer {
  /** The node the orb taps. Already routed to the speakers. */
  readonly node: GainNode;
  /** Queue a chunk of raw little-endian 16-bit PCM. */
  enqueue(bytes: ArrayBuffer | ArrayBufferView): void;
  /** Drop everything scheduled and not yet heard. Used for barge-in. */
  clear(): void;
  /** True while anything is still scheduled to play. */
  readonly playing: boolean;
  dispose(): void;
}

export interface PcmPlayerOptions {
  readonly context: AudioContext;
  /** Rate the agent is configured to send, e.g. 24000. */
  readonly sampleRate: number;
  /** Fired when the queue empties — the real end of the agent's voice. */
  readonly onDrained?: () => void;
  /** Fired when the first chunk of a new utterance starts. */
  readonly onStarted?: () => void;
}

/**
 * Play the agent's voice.
 *
 * The agent sends raw PCM with no container, so no decoder will touch it;
 * each chunk becomes an AudioBuffer and is scheduled back to back. An
 * AudioBuffer carries its own sample rate, so a 24kHz stream plays correctly
 * in a 48kHz context without resampling anything by hand.
 *
 * Scheduling, rather than playing each chunk on arrival, is what makes it
 * sound continuous: network jitter would otherwise put an audible gap between
 * every chunk.
 */
export function createPcmPlayer(options: PcmPlayerOptions): PcmPlayer {
  const { context, sampleRate } = options;

  const node = context.createGain();
  node.connect(context.destination);

  /** When the next chunk should begin, on the audio clock. */
  let nextStart = 0;
  const active = new Set<AudioBufferSourceNode>();

  /**
   * How far ahead of the audio clock to schedule the first chunk.
   *
   * Too small and the chunk is already in the past by the time it is queued,
   * which the browser renders as a click or drops entirely. Too large and the
   * agent sounds slow to answer.
   */
  const LEAD_SECONDS = 0.08;

  return {
    node,
    get playing() {
      return active.size > 0;
    },

    enqueue(bytes) {
      const samples = decodePcm16(bytes);
      if (samples.length === 0) return;

      const buffer = context.createBuffer(1, samples.length, sampleRate);
      buffer.copyToChannel(samples, 0);

      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(node);

      const now = context.currentTime;
      const wasIdle = active.size === 0;
      // If the queue ran dry, or we have fallen behind, start afresh rather
      // than scheduling into the past.
      if (nextStart < now + LEAD_SECONDS / 2) nextStart = now + LEAD_SECONDS;

      source.start(nextStart);
      nextStart += buffer.duration;

      active.add(source);
      source.onended = () => {
        active.delete(source);
        source.disconnect();
        if (active.size === 0) options.onDrained?.();
      };

      if (wasIdle) options.onStarted?.();
    },

    clear() {
      for (const source of active) {
        try {
          source.stop();
        } catch {
          // Already finished; onended will tidy up.
        }
      }
      active.clear();
      nextStart = 0;
    },

    dispose() {
      this.clear();
      node.disconnect();
    },
  };
}
