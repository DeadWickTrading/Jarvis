import { describe, expect, it } from 'vitest';
import { DEFAULT_VOICE_PREFERENCES, matchesPreference, pickVoice } from '../src/voices.js';
import type { VoiceLike } from '../src/voices.js';

const voice = (name: string, lang: string, extra: Partial<VoiceLike> = {}): VoiceLike => ({
  name,
  lang,
  ...extra,
});

/** Roughly what macOS offers. */
const MACOS = [
  voice('Alex', 'en-US', { localService: true }),
  voice('Daniel', 'en-GB', { localService: true }),
  voice('Karen', 'en-AU', { localService: true }),
  voice('Samantha', 'en-US', { localService: true, default: true }),
];

/** Roughly what Chrome on Windows offers — no Daniel anywhere. */
const WINDOWS_CHROME = [
  voice('Microsoft David - English (United States)', 'en-US', { localService: true }),
  voice('Microsoft Ryan - English (United Kingdom)', 'en-GB', { localService: true }),
  voice('Google UK English Male', 'en-GB'),
  voice('Google US English', 'en-US'),
];

describe('pickVoice', () => {
  it('picks Daniel when the device has him', () => {
    const choice = pickVoice(MACOS);
    expect(choice?.voice.name).toBe('Daniel');
    expect(choice?.exact).toBe(true);
  });

  it('falls back to another British voice when Daniel is absent', () => {
    const choice = pickVoice(WINDOWS_CHROME);
    expect(choice?.voice.lang).toBe('en-GB');
    expect(choice?.exact).toBe(false);
    expect(choice?.why).toMatch(/british|uk/i);
  });

  it('falls back to any English before giving up', () => {
    const choice = pickVoice([voice('Samantha', 'en-US'), voice('Amélie', 'fr-FR')]);
    expect(choice?.voice.name).toBe('Samantha');
  });

  it('takes whatever exists rather than returning nothing', () => {
    const choice = pickVoice([voice('Amélie', 'fr-FR')]);
    expect(choice?.voice.name).toBe('Amélie');
    expect(choice?.why).toMatch(/only voice/i);
  });

  it('returns null only when the device has no voices at all', () => {
    // Headless browsers routinely report an empty list; the caller has to
    // cope rather than crash.
    expect(pickVoice([])).toBeNull();
  });

  it('prefers a local voice over a network one at the same rung', () => {
    const choice = pickVoice([
      voice('Google UK English Female', 'en-GB'),
      voice('Arthur', 'en-GB', { localService: true }),
    ]);
    expect(choice?.voice.name).toBe('Arthur');
  });

  it('explains which rung it settled for', () => {
    expect(pickVoice(MACOS)?.why).toMatch(/daniel/i);
    expect(pickVoice([voice('Hans', 'de-DE')])?.why).toBeTruthy();
  });
});

describe('matchesPreference', () => {
  it('matches a language prefix on hyphen boundaries only', () => {
    expect(matchesPreference(voice('x', 'en-GB'), { lang: 'en' })).toBe(true);
    expect(matchesPreference(voice('x', 'en-GB'), { lang: 'en-GB' })).toBe(true);
    expect(matchesPreference(voice('x', 'en-US'), { lang: 'en-GB' })).toBe(false);
    // "en" must not match a language that merely starts with those letters.
    expect(matchesPreference(voice('x', 'enm'), { lang: 'en' })).toBe(false);
  });

  it('ignores case and underscore/hyphen spelling of a tag', () => {
    expect(matchesPreference(voice('x', 'EN_gb'), { lang: 'en-GB' })).toBe(true);
  });

  it('matches names exactly when given a string, loosely when given a pattern', () => {
    expect(matchesPreference(voice('Daniel', 'en-GB'), { name: 'daniel' })).toBe(true);
    expect(matchesPreference(voice('Daniel (Enhanced)', 'en-GB'), { name: 'Daniel' })).toBe(false);
    expect(matchesPreference(voice('Daniel (Enhanced)', 'en-GB'), { name: /daniel/i })).toBe(true);
  });

  it('matches anything for an empty preference', () => {
    expect(matchesPreference(voice('Whatever', 'xx'), {})).toBe(true);
  });
});

describe('DEFAULT_VOICE_PREFERENCES', () => {
  it('asks for Daniel first and ends with a catch-all', () => {
    expect(DEFAULT_VOICE_PREFERENCES[0]).toMatchObject({ name: 'Daniel', lang: 'en-GB' });
    const last = DEFAULT_VOICE_PREFERENCES.at(-1)!;
    expect(last.name).toBeUndefined();
    expect(last.lang).toBeUndefined();
  });
});
