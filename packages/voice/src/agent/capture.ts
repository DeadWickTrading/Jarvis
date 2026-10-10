import { floatToInt16 } from './pcm.js';

/**
 * The worklet, as source.
 *
 * Shipped as a string and loaded from a blob URL rather than as a separate
 * asset, so the package needs no bundler plugin, no copied file and no public
 * path to go wrong. An AudioWorklet runs on the audio thread, which is the
 * only way to capture without the stutter a ScriptProcessor introduces.
 *
 * It accumulates before posting. `process` is called every 128 frames, which
 * at 48kHz is 375 messages a second; batching to roughly 20ms cuts that to
 * fifty while staying far below any latency anyone can hear.
 */
const CAPTURE_WORKLET = `
class JarwickCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.target = options.processorOptions.framesPerChunk;
    this.chunk = new Float32Array(this.target);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    let offset = 0;
    while (offset < channel.length) {
      const take = Math.min(this.target - this.filled, channel.length - offset);
      this.chunk.set(channel.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.target) {
        // slice() copies: the engine reuses its buffers between calls.
        this.port.postMessage(this.chunk.slice(0));
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('jarwick-capture', JarwickCaptureProcessor);
`;

export interface MicCapture {
  /** Stop capturing and release every node. Does not stop the MediaStream. */
  dispose(): void;
}

export interface MicCaptureOptions {
  readonly context: AudioContext;
  readonly stream: MediaStream;
  /** Called with each block of 16-bit PCM, ready for the wire. */
  readonly onFrame: (pcm: Int16Array) => void;
  /** Roughly how much audio per message. 20ms is a good balance. */
  readonly chunkMs?: number;
}

let workletUrl: string | null = null;
const loadedContexts = new WeakSet<AudioContext>();

/** Register the worklet once per context; the blob URL is made once per page. */
async function ensureWorklet(context: AudioContext): Promise<void> {
  if (loadedContexts.has(context)) return;
  if (!context.audioWorklet) {
    throw new Error('jarwick: this browser has no AudioWorklet, so the microphone cannot be used');
  }
  workletUrl ??= URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }));
  await context.audioWorklet.addModule(workletUrl);
  loadedContexts.add(context);
}

/**
 * Stream a microphone into 16-bit PCM blocks.
 *
 * Nothing here is connected to the destination: the microphone must never be
 * routed to the speakers, which would be an instant feedback loop. The
 * worklet is a leaf, and `process` returning true keeps it alive without an
 * output.
 */
export async function createMicCapture(options: MicCaptureOptions): Promise<MicCapture> {
  const { context, stream, onFrame } = options;
  await ensureWorklet(context);

  const framesPerChunk = Math.max(
    128,
    Math.round((context.sampleRate * (options.chunkMs ?? 20)) / 1000),
  );

  const source = context.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(context, 'jarwick-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    processorOptions: { framesPerChunk },
  });

  worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
    onFrame(floatToInt16(event.data));
  };

  source.connect(worklet);

  return {
    dispose() {
      worklet.port.onmessage = null;
      try {
        source.disconnect(worklet);
      } catch {
        // Already torn down.
      }
      worklet.disconnect();
      source.disconnect();
    },
  };
}
