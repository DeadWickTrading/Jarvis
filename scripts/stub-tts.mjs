/**
 * A stand-in for Deepgram's /v1/speak, for testing without a key.
 *
 * It speaks no English, but it returns a real WAV whose amplitude follows a
 * speech-like envelope, which is everything the rest of the chain cares
 * about: the proxy forwards it, the browser decodes it, the orb taps it, and
 * the galaxy rides it. That exercises every link except Deepgram's own
 * servers — which is the one link a key would test and nothing else would.
 *
 *   node scripts/stub-tts.mjs [port]
 */
import { createServer } from 'node:http';

const PORT = Number(process.argv[2]) || 8787;
const SAMPLE_RATE = 24_000;

/** 16-bit mono PCM wrapped in a WAV container. */
function wav(samples, sampleRate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(clamped * 32_767), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

/**
 * Roughly a second of speech per twelve words, with syllables and pauses, and
 * enough low-mid energy to register in the voice band the orb measures.
 */
function speechLike(text) {
  const seconds = Math.min(20, Math.max(1.2, (text.split(/\s+/).length / 12) * 1.6));
  const total = Math.round(seconds * SAMPLE_RATE);
  const out = new Float32Array(total);
  const TAU = Math.PI * 2;

  for (let i = 0; i < total; i += 1) {
    const t = i / SAMPLE_RATE;
    const syllable = Math.pow(0.5 + 0.5 * Math.sin(t * TAU * 3.1 + 0.4 * Math.sin(t * TAU * 0.8)), 1.6);
    const phrase = Math.max(0, 0.62 + 0.4 * Math.sin(t * TAU * 0.21 + 1.1));
    const envelope = syllable * Math.min(1, phrase) * 0.5;

    // A 130Hz fundamental with harmonics through the speech band.
    const voice =
      Math.sin(t * TAU * 130) * 0.5 +
      Math.sin(t * TAU * 260) * 0.25 +
      Math.sin(t * TAU * 520) * 0.15 +
      Math.sin(t * TAU * 1040) * 0.08;

    out[i] = voice * envelope;
  }
  return out;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);

  if (!url.pathname.startsWith('/v1/speak')) {
    res.writeHead(404).end('not found');
    return;
  }
  if (!(req.headers.authorization ?? '').startsWith('Token ')) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ err_msg: 'stub: missing Token authorization' }));
    return;
  }

  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', () => {
    let text = '';
    try {
      text = JSON.parse(Buffer.concat(parts).toString('utf8')).text ?? '';
    } catch {
      res.writeHead(400).end('bad json');
      return;
    }
    if (text.length > 2000) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ err_msg: 'stub: text too long' }));
      return;
    }

    const audio = wav(speechLike(text), SAMPLE_RATE);
    res.writeHead(200, {
      'content-type': 'audio/wav',
      'content-length': String(audio.length),
      'dg-char-count': String(text.length),
      'x-stub': 'true',
    });
    res.end(audio);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`stub Deepgram listening on http://127.0.0.1:${PORT}`);
});
