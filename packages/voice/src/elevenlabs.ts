import { createRemoteVoice } from './remote.js';
import type { VoiceProvider } from './types.js';

export interface ElevenLabsVoiceOptions {
  readonly endpoint?: string;
  readonly healthEndpoint?: string;
  /** ElevenLabs voice id. Leave unset to use the server's configured default. */
  readonly voiceId?: string;
  readonly modelId?: string;
}

/**
 * ElevenLabs — the slot.
 *
 * Wired on the same rails as Deepgram: the same proxy, the same request
 * shape, the same decode-and-tap playback, so switching is a matter of
 * setting a key and picking this provider in the UI.
 *
 * It is written but unverified: no ElevenLabs key was available when it was
 * built, so the request shape follows their documented REST endpoint and the
 * proxy keeps the key server-side exactly as it does for Deepgram. Expect to
 * check the voice id and model id against your account before trusting it.
 */
export function createElevenLabsVoice(options: ElevenLabsVoiceOptions = {}): VoiceProvider {
  const body: Record<string, unknown> = {};
  if (options.voiceId) body.voiceId = options.voiceId;
  if (options.modelId) body.modelId = options.modelId;

  return createRemoteVoice({
    id: 'elevenlabs',
    label: 'ElevenLabs',
    // Their documented ceiling is far higher, but there is no reason to send
    // more in one request than Aura accepts, and it keeps the chunking
    // behaviour identical across providers.
    maxChars: 2000,
    endpoint: options.endpoint ?? '/api/tts/elevenlabs',
    healthEndpoint: options.healthEndpoint ?? '/api/tts/health',
    ...(Object.keys(body).length > 0 ? { body } : {}),
  });
}
