import { describe, expect, it } from 'vitest';
import { BROWSER_MAX_CHARS, chunkText, DEEPGRAM_MAX_CHARS } from '../src/chunk.js';

const words = (n: number, word = 'word') => Array.from({ length: n }, () => word).join(' ');

describe('chunkText', () => {
  it('leaves short text alone', () => {
    expect(chunkText('Good day, sir.', 100)).toEqual(['Good day, sir.']);
  });

  it('says nothing for empty or whitespace-only input', () => {
    expect(chunkText('', 100)).toEqual([]);
    expect(chunkText('   \n\t ', 100)).toEqual([]);
  });

  it('normalises runs of whitespace', () => {
    expect(chunkText('Good   day,\n\n sir.', 100)).toEqual(['Good day, sir.']);
  });

  it('never exceeds the limit, whatever the input', () => {
    const inputs = [
      words(500),
      'Short. '.repeat(400),
      'x'.repeat(5000),
      `${words(50)} ${'y'.repeat(900)} ${words(50)}`,
    ];
    for (const limit of [20, 64, BROWSER_MAX_CHARS, DEEPGRAM_MAX_CHARS]) {
      for (const input of inputs) {
        for (const chunk of chunkText(input, limit)) {
          expect(chunk.length, `limit ${limit}`).toBeLessThanOrEqual(limit);
          expect(chunk.trim()).not.toBe('');
        }
      }
    }
  });

  it('prefers to break between sentences', () => {
    const text = 'The level held. Price reclaimed the gamma flip. I would wait for the retest.';
    const chunks = chunkText(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk should end where a sentence does.
    for (const chunk of chunks) expect(chunk).toMatch(/[.!?…]$/);
  });

  it('packs several short sentences into one piece rather than one each', () => {
    const chunks = chunkText('One. Two. Three. Four.', 100);
    expect(chunks).toEqual(['One. Two. Three. Four.']);
  });

  it('falls back to word boundaries inside an over-long sentence', () => {
    const chunks = chunkText(`${words(80)} and then it ended.`, 50);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
      // No chunk should begin or end mid-word.
      expect(chunk).not.toMatch(/^\S*wor$|^ord\b/);
    }
    expect(chunks.join(' ')).toContain('and then it ended.');
  });

  it('only cuts a word when the word itself is too long', () => {
    const long = 'z'.repeat(130);
    const chunks = chunkText(`before ${long} after`, 50);
    expect(chunks.every((c) => c.length <= 50)).toBe(true);
    expect(chunks.join('').replace(/\s/g, '')).toContain(long);
  });

  it('preserves the words, in order', () => {
    const text =
      'Good day, sir. Jarwick online. What do you need? The call wall sits at twenty-one thousand four hundred.';
    const rejoined = chunkText(text, 30).join(' ');
    expect(rejoined.replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '));
  });

  it('does not split a price at its decimal point', () => {
    const chunks = chunkText('Price is 31,240.50 on the session.', 200);
    expect(chunks).toEqual(['Price is 31,240.50 on the session.']);
  });

  it('keeps an abbreviation with its sentence', () => {
    const chunks = chunkText('Mr. Wick is flat. The U.S. open is next.', 200);
    expect(chunks).toHaveLength(1);
  });

  it('rejects a nonsensical limit rather than looping forever', () => {
    expect(() => chunkText('anything', 0)).toThrow(/positive/);
    expect(() => chunkText('anything', -5)).toThrow(/positive/);
  });

  it('stays under the documented provider ceilings', () => {
    // Deepgram answers 413 above 2000 characters and returns no audio at all.
    expect(DEEPGRAM_MAX_CHARS).toBeLessThan(2000);
    expect(BROWSER_MAX_CHARS).toBeLessThan(DEEPGRAM_MAX_CHARS);
  });
});
