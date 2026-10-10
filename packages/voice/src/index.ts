/**
 * Speech for Jarwick.
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

export { createVoiceAgent } from './agent/agent.js';
export type { VoiceAgent, VoiceAgentOptions } from './agent/agent.js';
export { connectAgent, DEFAULT_AGENT_URL, DEFAULT_AUTH_STRATEGIES } from './agent/connection.js';
export type { AgentAuthStrategy, AgentConnection } from './agent/connection.js';
export { resolveOrbState, IDLE_STATUS } from './agent/state.js';
export type { AgentStatus, AgentConnection as AgentConnectionState } from './agent/state.js';
export { floatToInt16, int16ToFloat, decodePcm16, rms } from './agent/pcm.js';
export { createPcmPlayer } from './agent/playback.js';
export type { PcmPlayer } from './agent/playback.js';
export { createMicCapture } from './agent/capture.js';
export type { MicCapture } from './agent/capture.js';

export type {
  AudioSink,
  SpeakOptions,
  SpeakerScene,
  VoiceAvailability,
  VoiceProvider,
} from './types.js';
