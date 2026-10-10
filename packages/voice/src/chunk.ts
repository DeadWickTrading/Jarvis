/**
 * Splitting text into speakable pieces.
 *
 * Two unrelated limits make this necessary, and both fail quietly if ignored:
 *
 *   - Deepgram's /v1/speak rejects anything over 2000 characters with a 413,
 *     and produces no audio at all.
 *   - Chrome's speech synthesis truncates a long utterance partway through,
 *     a bug of many years' standing. Feeding it a few sentences at a time
 *     sidesteps it.
 *
 * Splitting on sentence boundaries rather than at a character count also
 * sounds better: every provider gives a sentence its own intonation and a
 * natural pause at the end, where a cut mid-clause lands awkwardly.
 */

/** Conservative default: Deepgram's documented ceiling is 2000. */
export const DEEPGRAM_MAX_CHARS = 1800;
/** Chrome starts dropping audio well before this; short pieces are safer. */
export const BROWSER_MAX_CHARS = 220;

/** Split on sentence endings, keeping the punctuation with its sentence. */
function toSentences(text: string): string[] {
  // A sentence ends at . ! ? or an ellipsis, optionally followed by a closing
  // quote or bracket, and then whitespace. Decimal numbers and common
  // abbreviations would be split wrongly by a naive rule, so a full stop
  // between two digits, or after a single capital, does not end a sentence.
  const parts = text.match(/[^.!?…]+(?:[.!?…]+["'’”)\]]*|$)/g);
  if (!parts) return [text];

  const sentences: string[] = [];
  for (const raw of parts) {
    const piece = raw.trim();
    if (piece.length === 0) continue;

    const previous = sentences[sentences.length - 1];
    const joinsToPrevious =
      previous !== undefined &&
      // "31,240.50" — a decimal point should not have ended the sentence.
      (/\d[.,]$/.test(previous) ||
        // "Mr." / "e.g." / "U.S." — an initial or abbreviation, not an ending.
        /(?:^|\s)(?:[A-Z]|[A-Za-z]{1,2}\.[A-Za-z])\.$/.test(previous));

    if (joinsToPrevious) sentences[sentences.length - 1] = `${previous} ${piece}`;
    else sentences.push(piece);
  }
  return sentences.length > 0 ? sentences : [text];
}

/** Break an over-long run of text at word boundaries, then hard-split if forced. */
function splitLongPiece(piece: string, maxChars: number): string[] {
  if (piece.length <= maxChars) return [piece];

  const out: string[] = [];
  let current = '';
  for (const word of piece.split(/\s+/)) {
    if (word.length === 0) continue;

    if (word.length > maxChars) {
      // A single unbroken token longer than the limit — a URL, or a very long
      // identifier. Nothing to do but cut it.
      if (current) {
        out.push(current);
        current = '';
      }
      for (let i = 0; i < word.length; i += maxChars) out.push(word.slice(i, i + maxChars));
      continue;
    }

    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars) {
      out.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Split `text` into pieces of at most `maxChars`, preferring sentence
 * boundaries, then word boundaries, and only cutting a word as a last resort.
 *
 * Never returns an empty piece, and never returns a piece longer than the
 * limit. Empty or whitespace-only input returns an empty array: there is
 * nothing to say.
 */
export function chunkText(text: string, maxChars: number): string[] {
  if (!(maxChars > 0)) throw new Error(`chunkText: maxChars must be positive, got ${maxChars}`);

  const normalised = text.replace(/\s+/g, ' ').trim();
  if (normalised.length === 0) return [];
  if (normalised.length <= maxChars) return [normalised];

  const chunks: string[] = [];
  let current = '';

  for (const sentence of toSentences(normalised)) {
    for (const piece of splitLongPiece(sentence, maxChars)) {
      const candidate = current ? `${current} ${piece}` : piece;
      if (candidate.length > maxChars) {
        if (current) chunks.push(current);
        current = piece;
      } else {
        current = candidate;
      }
    }
  }
  if (current) chunks.push(current);

  return chunks;
}
