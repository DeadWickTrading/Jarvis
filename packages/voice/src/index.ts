/**
 * Speech for Jarvis.
 *
 * Three ways to talk behind one interface: the browser's own synthesiser
 * (free, offline, no key), Deepgram Aura (real audio the orb can ride), and
 * ElevenLabs (the same rails, waiting for a key).
 */
export { createSpeaker, createSceneSink } from './speaker.js';
export type { Speaker, SpeakerOptions } from './speaker.js';

export { createBrowserVoice } from './browser.js';
export type { BrowserVoiceOptions } from './browser.js';

export { createDeepgramVoice } from './deepgram.js';
export type { DeepgramVoiceOptions } from './deepgram.js';

export { createElevenLabsVoice } from './elevenlabs.js';
export type { ElevenLabsVoiceOptions } from './elevenlabs.js';

export { createRemoteVoice } from './remote.js';
export type { RemoteVoiceOptions } from './remote.js';

export { chunkText, BROWSER_MAX_CHARS, DEEPGRAM_MAX_CHARS } from './chunk.js';
export {
  pickVoice,
  matchesPreference,
  DEFAULT_VOICE_PREFERENCES,
} from './voices.js';
export type { VoiceLike, VoicePreference, VoiceChoice } from './voices.js';

export type {
  AudioSink,
  SpeakOptions,
  SpeakerScene,
  VoiceAvailability,
  VoiceProvider,
} from './types.js';
