import { BROWSER_MAX_CHARS } from './chunk.js';
import type { SpeakOptions, VoiceAvailability, VoiceProvider } from './types.js';
import { DEFAULT_VOICE_PREFERENCES, pickVoice, type VoicePreference } from './voices.js';

export interface BrowserVoiceOptions {
  /** Ordered ladder of voices to try. Defaults to Daniel, then British, then English. */
  readonly preferences?: readonly VoicePreference[];
  readonly rate?: number;
  readonly pitch?: number;
  readonly volume?: number;
}

/**
 * The operating system's own speech synthesis.
 *
 * Free, offline, no key, available in every modern browser — and the reason
 * Jarwick can talk before any account exists.
 *
 * Its one real limitation is that it provides no audio stream. The Web Speech
 * API hands the utterance straight to the platform's synthesiser and the
 * audio never passes through Web Audio, so there is nothing to attach an
 * analyser to. The orb therefore animates from its synthetic envelope while
 * this provider speaks: convincing, but not the actual waveform.
 */
export function createBrowserVoice(options: BrowserVoiceOptions = {}): VoiceProvider {
  const preferences = options.preferences ?? DEFAULT_VOICE_PREFERENCES;
  let current: SpeechSynthesisUtterance | null = null;
  let keepAlive: ReturnType<typeof setInterval> | null = null;

  const synth = (): SpeechSynthesis | null =>
    typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;

  /**
   * Voices load asynchronously and the first call usually returns an empty
   * list, so wait for `voiceschanged` — but not forever: some browsers never
   * fire it, and some devices genuinely have no voices.
   */
  const loadVoices = async (timeoutMs = 2000): Promise<SpeechSynthesisVoice[]> => {
    const speech = synth();
    if (!speech) return [];

    const immediate = speech.getVoices();
    if (immediate.length > 0) return immediate;

    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        speech.removeEventListener('voiceschanged', done);
        resolve(speech.getVoices());
      };
      const timer = setTimeout(done, timeoutMs);
      speech.addEventListener('voiceschanged', done);
    });
  };

  const chooseVoice = async () => {
    const voices = await loadVoices();
    return pickVoice(voices, preferences);
  };

  const stopKeepAlive = (): void => {
    if (keepAlive !== null) {
      clearInterval(keepAlive);
      keepAlive = null;
    }
  };

  return {
    id: 'browser',
    label: 'Browser speech',
    providesAudioStream: false,
    maxChars: BROWSER_MAX_CHARS,

    async available(): Promise<VoiceAvailability> {
      if (!synth()) {
        return { ok: false, reason: 'This browser has no speech synthesis.' };
      }
      const choice = await chooseVoice();
      if (!choice) {
        return {
          ok: false,
          reason:
            'The browser reports no installed voices. On Linux this usually means no speech-dispatcher voices are installed.',
        };
      }
      return {
        ok: true,
        detail: choice.exact
          ? `Daniel (${choice.voice.lang})`
          : `${choice.voice.name} (${choice.voice.lang}) — ${choice.why}`,
      };
    },

    async speak(text: string, { signal, onAudioStart }: SpeakOptions): Promise<void> {
      const speech = synth();
      if (!speech) throw new Error('browser voice: speech synthesis is unavailable');
      if (signal?.aborted) return;

      const choice = await chooseVoice();
      const utterance = new SpeechSynthesisUtterance(text);
      // Only take the chosen voice if it actually speaks English. On a Mac set to
      // another language the ladder can bottom out on, say, a Norwegian voice,
      // which then reads English with a Norwegian accent; asking for en-GB lets
      // the platform pick a British voice instead.
      if (choice && /^en\b/i.test(choice.voice.lang)) {
        utterance.voice = choice.voice as SpeechSynthesisVoice;
        utterance.lang = choice.voice.lang;
      } else {
        utterance.lang = 'en-GB';
      }
      utterance.rate = options.rate ?? 1;
      utterance.pitch = options.pitch ?? 1;
      utterance.volume = options.volume ?? 1;
      current = utterance;

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          stopKeepAlive();
          signal?.removeEventListener('abort', onAbort);
          current = null;
          if (error) reject(error);
          else resolve();
        };

        const onAbort = (): void => {
          speech.cancel();
          finish();
        };

        utterance.onstart = () => onAudioStart?.();
        utterance.onend = () => finish();
        utterance.onerror = (event) => {
          // Cancelling raises an error event; that is a stop, not a fault.
          const reason = (event as SpeechSynthesisErrorEvent).error;
          if (reason === 'canceled' || reason === 'interrupted') finish();
          else finish(new Error(`browser voice: ${reason ?? 'speech failed'}`));
        };

        signal?.addEventListener('abort', onAbort, { once: true });

        // Chrome stops speaking after roughly fifteen seconds unless it is
        // nudged. Chunking keeps utterances short enough that this rarely
        // matters, but a pause/resume tick costs nothing and covers the case
        // where a chunk is long or the machine is slow.
        stopKeepAlive();
        keepAlive = setInterval(() => {
          if (!speech.speaking) return;
          speech.pause();
          speech.resume();
        }, 10_000);

        speech.speak(utterance);
      });
    },

    cancel(): void {
      stopKeepAlive();
      current = null;
      synth()?.cancel();
    },

    dispose(): void {
      this.cancel();
    },
  };
}
