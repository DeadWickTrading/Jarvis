import type { AudioTapSource } from '../types.js';

/**
 * A read-only window onto a stream's spectrum.
 *
 * Every tap here is additive: the analyser is a leaf node, so attaching one
 * cannot change what the user hears.
 */
export interface AudioTap {
  /** Frequency bins for the current moment, 0..255 per bin. */
  read(): Uint8Array;
  /** Sample rate of the context, needed to turn bins into frequencies. */
  readonly sampleRate: number;
  /** Disconnect and release. Does not close the shared AudioContext. */
  dispose(): void;
}

/**
 * FFT size. 2048 gives 1024 bins, about 23Hz apart at the usual sample rate.
 *
 * 512 would be cheaper, but its 94Hz bins are too coarse to separate the bass
 * band from the voice band at all: a male fundamental and the low end of the
 * speech range would land in the same two or three bins.
 */
const FFT_SIZE = 2048;

/**
 * `createMediaElementSource` may only be called once per element per context,
 * and doing it twice throws. Remember the nodes we have already made.
 */
const elementSources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();

/** Lazily-created, shared between taps belonging to one engine instance. */
export interface AudioContextHolder {
  /** The context, created on first use. */
  get(): AudioContext;
  /** Close the context if it was ever created. */
  close(): Promise<void>;
}

export function createAudioContextHolder(): AudioContextHolder {
  let ctx: AudioContext | null = null;
  return {
    get() {
      if (!ctx) {
        const Ctor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) throw new Error('Web Audio is not available in this browser');
        ctx = new Ctor();
      }
      // Autoplay policy leaves a fresh context suspended until a gesture.
      if (ctx.state === 'suspended') void ctx.resume();
      return ctx;
    },
    async close() {
      if (ctx && ctx.state !== 'closed') await ctx.close();
      ctx = null;
    },
  };
}

/**
 * Attach an analyser to `source` without altering playback.
 *
 * For a `MediaStream` or an existing `AudioNode` this is a pure fan-out: the
 * analyser is an extra consumer and the original path is untouched.
 *
 * An `HTMLMediaElement` is the one case needing care. Calling
 * `createMediaElementSource` on an element moves its output off the default
 * device and into the graph, so the engine immediately reconnects it to the
 * destination. Without that line the element would fall silent — "tap only"
 * has to be arranged, not assumed.
 */
export function createAudioTap(source: AudioTapSource, holder: AudioContextHolder): AudioTap {
  const ctx = holder.get();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  // The engine does its own asymmetric smoothing on the CPU, where it is
  // frame-rate corrected; letting the analyser smooth as well would just add
  // untracked lag.
  analyser.smoothingTimeConstant = 0;

  const bins = new Uint8Array(analyser.frequencyBinCount);
  const ownedNodes: AudioNode[] = [];
  let input: AudioNode;

  if (typeof MediaStream !== 'undefined' && source instanceof MediaStream) {
    const node = ctx.createMediaStreamSource(source);
    ownedNodes.push(node);
    input = node;
  } else if (typeof HTMLMediaElement !== 'undefined' && source instanceof HTMLMediaElement) {
    let node = elementSources.get(source);
    if (!node) {
      node = ctx.createMediaElementSource(source);
      elementSources.set(source, node);
      // Restore the path to the speakers that createMediaElementSource took.
      node.connect(ctx.destination);
    }
    input = node;
  } else {
    const node = source as AudioNode;
    // Web Audio cannot connect nodes across contexts, and the error it throws
    // says nothing about which contexts are involved. A host building its own
    // nodes must build them in the engine's context, which it gets from
    // OrbSceneHandle.getAudioContext().
    if (node.context !== ctx) {
      throw new Error(
        'orb-engine: the AudioNode belongs to a different AudioContext. ' +
          'Build nodes with the context from OrbSceneHandle.getAudioContext().',
      );
    }
    input = node;
  }

  input.connect(analyser);

  return {
    sampleRate: ctx.sampleRate,
    read() {
      analyser.getByteFrequencyData(bins);
      return bins;
    },
    dispose() {
      try {
        input.disconnect(analyser);
      } catch {
        // Already torn down, or the graph outlived its context. Nothing to do.
      }
      analyser.disconnect();
      // Element sources are cached and shared, so they are not ours to drop.
      for (const node of ownedNodes) node.disconnect();
    },
  };
}
