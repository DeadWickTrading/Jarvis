import { decodePcm16 } from './pcm.js';

export interface PcmPlayer {
  /** The node the orb taps. Already routed to the speakers. */
  readonly node: GainNode;
  /** Queue a chunk of raw little-endian 16-bit PCM. */
  enqueue(bytes: ArrayBuffer | ArrayBufferView): void;
  /** Drop everything scheduled and not yet heard. Used for barge-in. */
  clear(): void;
  /** Start playing whatever is staged, even if the prime target is not reached (the agent said it is done). */
  flush(): void;
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
  /**
   * Audio to hold back before an utterance starts, in seconds (default 0.25).
   * The agent's chunks arrive in bursts; starting on the first one means the
   * second is often late, which is heard as a stutter. Priming costs that much
   * delay once per utterance and buys smooth speech. 0 = start at once.
   */
  readonly primeSeconds?: number;
  /** Never hold staged audio longer than this (default 0.6 s), even if the prime target is not reached. */
  readonly maxHoldSeconds?: number;
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
  const LEAD_SECONDS = 0.12;
  const PRIME = options.primeSeconds ?? 0.25;
  const MAX_HOLD = options.maxHoldSeconds ?? 0.6;

  /** Chunks held back until the prime target (or flush). */
  let staged: AudioBuffer[] = [];
  let stagedSeconds = 0;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (buffer: AudioBuffer): void => {
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
  };

  const release = (): void => {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
    const list = staged;
    staged = [];
    stagedSeconds = 0;
    for (const b of list) schedule(b);
  };

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

      // Mid-utterance (something is playing and we are ahead of the clock):
      // schedule straight on the back of it. Otherwise stage until primed.
      const ahead = nextStart - context.currentTime;
      if (active.size > 0 && ahead > LEAD_SECONDS / 2 && staged.length === 0) {
        schedule(buffer);
        return;
      }
      staged.push(buffer);
      stagedSeconds += buffer.duration;
      if (stagedSeconds >= PRIME || PRIME <= 0) release();
      else if (!holdTimer) holdTimer = setTimeout(release, MAX_HOLD * 1000);
    },

    flush() {
      if (staged.length) release();
    },

    clear() {
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = null;
      staged = [];
      stagedSeconds = 0;
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
