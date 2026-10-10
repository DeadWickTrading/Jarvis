/**
 * Choosing a browser voice.
 *
 * `speechSynthesis.getVoices()` returns whatever the operating system happens
 * to ship, which differs on every machine. Daniel is Apple's en-GB voice and
 * is not present on Windows, Android or most Linux installs, so asking for it
 * by name has to be the first move in a chain rather than the only one.
 *
 * Kept pure and separate from the Web Speech API so the chain can be tested
 * against hand-written voice lists instead of whatever the test machine owns.
 */

/** The parts of `SpeechSynthesisVoice` this module needs. */
export interface VoiceLike {
  readonly name: string;
  readonly lang: string;
  readonly localService?: boolean;
  readonly default?: boolean;
}

/**
 * One rung of the preference ladder. A voice matches when every field that is
 * specified matches; an empty preference matches anything.
 */
export interface VoicePreference {
  /** Exact name (case-insensitive) or a pattern to test against the name. */
  readonly name?: string | RegExp;
  /**
   * BCP-47 tag. Matching is prefix-based on hyphen boundaries, so `en` matches
   * `en-GB` and `en-US`, while `en-GB` matches only British English.
   */
  readonly lang?: string;
  /** A short note for the UI explaining why this rung was chosen. */
  readonly why?: string;
}

/**
 * The default ladder: Daniel first, then other British English voices that
 * are commonly installed, then any British English, then any English at all.
 */
export const DEFAULT_VOICE_PREFERENCES: readonly VoicePreference[] = [
  { name: 'Daniel', lang: 'en-GB', why: 'Daniel, the requested British voice' },
  { name: /daniel/i, why: 'a Daniel voice' },
  // Commonly present British voices on Windows, Chrome and Android.
  { name: /google uk english male/i, why: 'Google UK English Male' },
  { name: /\b(ryan|george|thomas|arthur|oliver)\b/i, lang: 'en-GB', why: 'a British English voice' },
  { lang: 'en-GB', why: 'the first British English voice available' },
  { lang: 'en', why: 'an English voice, though not British' },
  { why: 'the only voice this device offers' },
];

function langMatches(voiceLang: string, wanted: string): boolean {
  const have = voiceLang.toLowerCase().replace(/_/g, '-');
  const want = wanted.toLowerCase().replace(/_/g, '-');
  return have === want || have.startsWith(`${want}-`);
}

function nameMatches(voiceName: string, wanted: string | RegExp): boolean {
  if (typeof wanted === 'string') return voiceName.toLowerCase() === wanted.toLowerCase();
  return wanted.test(voiceName);
}

/** Whether a single voice satisfies a single preference. */
export function matchesPreference(voice: VoiceLike, preference: VoicePreference): boolean {
  if (preference.name !== undefined && !nameMatches(voice.name, preference.name)) return false;
  if (preference.lang !== undefined && !langMatches(voice.lang, preference.lang)) return false;
  return true;
}

export interface VoiceChoice {
  readonly voice: VoiceLike;
  /** Which rung of the ladder matched, for showing the user. */
  readonly why: string;
  /** True when the first preference matched, i.e. we got exactly what we asked for. */
  readonly exact: boolean;
}

/**
 * Walk the ladder and return the first voice that matches, or null when the
 * device offers nothing at all.
 *
 * Within a rung, a locally-installed voice wins over a network one: local
 * voices start instantly and keep working offline, which matters for
 * something that is meant to answer immediately.
 */
export function pickVoice(
  voices: readonly VoiceLike[],
  preferences: readonly VoicePreference[] = DEFAULT_VOICE_PREFERENCES,
): VoiceChoice | null {
  if (voices.length === 0) return null;

  for (let rung = 0; rung < preferences.length; rung += 1) {
    const preference = preferences[rung]!;
    const matches = voices.filter((voice) => matchesPreference(voice, preference));
    if (matches.length === 0) continue;

    const best =
      matches.find((v) => v.localService === true) ??
      matches.find((v) => v.default === true) ??
      matches[0]!;

    return {
      voice: best,
      why: preference.why ?? `matched preference ${rung + 1}`,
      exact: rung === 0,
    };
  }
  return null;
}
