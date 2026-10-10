import { DEEPGRAM_MAX_CHARS } from './chunk.js';
import { createRemoteVoice } from './remote.js';
import type { VoiceProvider } from './types.js';

export interface DeepgramVoiceOptions {
  /** Proxy route that forwards to Deepgram. */
  readonly endpoint?: string;
  readonly healthEndpoint?: string;
  /**
   * Aura model id.
   *
   * `aura-helios-en` is a British male voice, which is the closest Aura comes
   * to Daniel and matches the Voice Agent configuration this project is built
   * around. Leave it unset to use whatever the server is configured with.
   */
  readonly model?: string;
}

/**
 * Deepgram Aura, reached through this project's speech proxy.
 *
 * Aura answers with audio bytes, so the orb taps the real waveform rather
 * than falling back to the synthetic envelope.
 *
 * Deepgram rejects anything over 2000 characters with a 413 and returns no
 * audio at all, so text is chunked well below that before it gets here.
 */
export function createDeepgramVoice(options: DeepgramVoiceOptions = {}): VoiceProvider {
  return createRemoteVoice({
    id: 'deepgram',
    label: 'Deepgram Aura',
    maxChars: DEEPGRAM_MAX_CHARS,
    endpoint: options.endpoint ?? '/api/tts/deepgram',
    healthEndpoint: options.healthEndpoint ?? '/api/tts/health',
    ...(options.model ? { body: { model: options.model } } : {}),
  });
}
