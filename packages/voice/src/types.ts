import type { OrbState } from '@deadwick/orb-engine';

/** Where a provider's audio goes so the orb can ride its waveform. */
export interface AudioSink {
  /**
   * The AudioContext any node must be built in.
   *
   * Web Audio refuses to connect nodes across contexts, so a provider that
   * synthesises or decodes audio has to build it here rather than in a
   * context of its own.
   */
  context(): AudioContext;
  /**
   * Hand the orb a node to tap, or `null` to detach.
   *
   * The engine only adds an analyser branch; it does not route the node to
   * the speakers. A provider that wants to be heard must connect to
   * `context().destination` itself.
   */
  attach(node: AudioNode | null): void;
}

export interface SpeakOptions {
  /** Aborting stops playback and settles the promise. */
  readonly signal?: AbortSignal;
  /** Where decoded audio should go. Absent for providers with no stream. */
  readonly sink?: AudioSink;
  /**
   * Called the moment sound actually starts.
   *
   * `speak` resolves when audio *finishes*, which is far too late to move the
   * orb out of its thinking state. Providers fire this when the first sample
   * is heard — after the network round trip and decode for a remote voice,
   * on `onstart` for the browser.
   */
  readonly onAudioStart?: () => void;
}

export interface VoiceAvailability {
  readonly ok: boolean;
  /** Why not, in words a user can act on. */
  readonly reason?: string;
  /** What will actually be heard, once known. */
  readonly detail?: string;
}

/**
 * One way of turning text into speech.
 *
 * The interface is deliberately small: everything the orb needs to know is
 * whether real audio will be available to tap, and how much text can go in
 * one request.
 */
export interface VoiceProvider {
  readonly id: string;
  readonly label: string;
  /**
   * Whether the orb can read this provider's real waveform.
   *
   * False for browser speech synthesis, which exposes no audio stream at any
   * point — the orb falls back to its synthetic envelope, which looks like
   * speech but has no relationship to what is being said.
   */
  readonly providesAudioStream: boolean;
  /** Longest text accepted in a single request. */
  readonly maxChars: number;
  /** Can this be used right now, and what will it sound like? */
  available(): Promise<VoiceAvailability>;
  /** Speak one chunk. Resolves when its audio has finished or been stopped. */
  speak(text: string, options: SpeakOptions): Promise<void>;
  /** Stop immediately. */
  cancel(): void;
  dispose?(): void;
}

/** The slice of the orb's handle the speaker drives. */
export interface SpeakerScene {
  setState(state: OrbState): void;
  getState(): OrbState;
}
