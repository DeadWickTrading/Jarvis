import type { AudioSink, SpeakOptions, VoiceAvailability, VoiceProvider } from './types.js';

export interface RemoteVoiceOptions {
  readonly id: string;
  readonly label: string;
  readonly maxChars: number;
  /** Proxy route that returns audio bytes for a piece of text. */
  readonly endpoint: string;
  /** Proxy route reporting which providers hold credentials. */
  readonly healthEndpoint: string;
  /** Extra fields merged into the request body, e.g. a model or voice id. */
  readonly body?: Readonly<Record<string, unknown>>;
}

interface HealthReport {
  providers?: Record<string, { configured?: boolean; detail?: string; reason?: string }>;
}

/**
 * A voice that comes back from the network as audio bytes.
 *
 * Both Deepgram and ElevenLabs work this way, and both are reached through a
 * small proxy of our own rather than directly. That is not ceremony: an API
 * key shipped to the browser is a key published to anyone who opens the
 * network tab, and a bill anyone can run up. The key stays on the server and
 * the browser only ever sees text going out and audio coming back.
 *
 * Because the audio arrives as bytes, it can be decoded into the orb's own
 * AudioContext and tapped — so unlike browser synthesis, the galaxy really
 * does ride the waveform of what is being said.
 */
export function createRemoteVoice(options: RemoteVoiceOptions): VoiceProvider {
  let controller: AbortController | null = null;
  let playing: AudioBufferSourceNode | null = null;

  const stopPlayback = (): void => {
    if (playing) {
      try {
        playing.stop();
      } catch {
        // Already stopped, or never started. Either way there is nothing to do.
      }
      playing = null;
    }
  };

  return {
    id: options.id,
    label: options.label,
    providesAudioStream: true,
    maxChars: options.maxChars,

    async available(): Promise<VoiceAvailability> {
      let report: HealthReport;
      try {
        const response = await fetch(options.healthEndpoint, { method: 'GET' });
        if (!response.ok) {
          return { ok: false, reason: `The speech proxy answered ${response.status}.` };
        }
        report = (await response.json()) as HealthReport;
      } catch {
        return {
          ok: false,
          reason: `No speech proxy at ${options.healthEndpoint}. Start the dev server, or point the demo at your own.`,
        };
      }

      const entry = report.providers?.[options.id];
      if (!entry?.configured) {
        return { ok: false, reason: entry?.reason ?? `${options.label} has no API key configured.` };
      }
      return { ok: true, detail: entry.detail ?? options.label };
    },

    async speak(text: string, { signal, sink, onAudioStart }: SpeakOptions): Promise<void> {
      if (!sink) throw new Error(`${options.id}: an audio sink is required to play remote audio`);
      if (signal?.aborted) return;

      controller = new AbortController();
      const onAbort = (): void => controller?.abort();
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        const response = await fetch(options.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, ...options.body }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new Error(
            `${options.label} returned ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
          );
        }

        const bytes = await response.arrayBuffer();
        if (signal?.aborted || bytes.byteLength === 0) return;

        await playBuffer(bytes, sink, signal, (node) => {
          playing = node;
        }, onAudioStart);
      } catch (error) {
        // An abort is a stop, not a failure.
        if ((error as Error)?.name === 'AbortError' || signal?.aborted) return;
        throw error;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        controller = null;
        playing = null;
        sink.attach(null);
      }
    },

    cancel(): void {
      controller?.abort();
      controller = null;
      stopPlayback();
    },

    dispose(): void {
      this.cancel();
    },
  };
}

/** Decode bytes in the orb's context, route them to the speakers, and tap them. */
async function playBuffer(
  bytes: ArrayBuffer,
  sink: AudioSink,
  signal: AbortSignal | undefined,
  register: (node: AudioBufferSourceNode) => void,
  onAudioStart: (() => void) | undefined,
): Promise<void> {
  const context = sink.context();
  if (context.state === 'suspended') await context.resume();

  const buffer = await context.decodeAudioData(bytes);
  if (signal?.aborted) return;

  const source = context.createBufferSource();
  source.buffer = buffer;

  // The gain node is what the orb taps. The engine only adds an analyser
  // branch, so the route to the speakers has to be made here or the audio
  // would be analysed and never heard.
  const gain = context.createGain();
  source.connect(gain);
  gain.connect(context.destination);
  sink.attach(gain);
  register(source);

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      source.disconnect();
      gain.disconnect();
      resolve();
    };
    const onAbort = (): void => {
      try {
        source.stop();
      } catch {
        // Stopping a source that already ended throws; harmless.
      }
      finish();
    };

    source.onended = finish;
    signal?.addEventListener('abort', onAbort, { once: true });
    source.start();
    onAudioStart?.();
  });
}
