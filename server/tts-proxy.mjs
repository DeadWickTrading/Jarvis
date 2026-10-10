/**
 * The speech proxy.
 *
 * Exists for one reason: an API key shipped to the browser is a key published
 * to anyone who opens the network tab, and a bill anyone can run up. The key
 * stays here. The browser only ever sends text and receives audio.
 *
 * It is a plain `(req, res, next)` handler so the same code serves as Vite
 * middleware in development and as a route in any Node server in production.
 *
 * Routes:
 *   GET  /api/tts/health       which providers hold credentials
 *   POST /api/tts/deepgram     { text, model? }      -> audio bytes
 *   POST /api/tts/elevenlabs   { text, voiceId? }    -> audio bytes
 */

/** Deepgram answers 413 above 2000 characters and returns no audio at all. */
const MAX_TEXT_CHARS = 2000;
/** Generous for speech, small enough that nobody can post a film script. */
const MAX_BODY_BYTES = 64 * 1024;

const DEFAULTS = {
  deepgramBaseUrl: 'https://api.deepgram.com',
  deepgramModel: 'aura-helios-en',
  elevenLabsBaseUrl: 'https://api.elevenlabs.io',
  elevenLabsModel: 'eleven_turbo_v2_5',
};

/** Model and voice ids go into a URL, so they are constrained rather than trusted. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function readConfig(env) {
  return {
    deepgram: {
      key: env.DEEPGRAM_API_KEY ?? '',
      model: env.DEEPGRAM_TTS_MODEL || DEFAULTS.deepgramModel,
      baseUrl: env.DEEPGRAM_BASE_URL || DEFAULTS.deepgramBaseUrl,
      // Left unset by default: Deepgram picks a format and decodeAudioData in
      // the browser sniffs whatever arrives. Pin them only if you need a
      // specific container.
      encoding: env.DEEPGRAM_TTS_ENCODING || '',
      container: env.DEEPGRAM_TTS_CONTAINER || '',
    },
    elevenlabs: {
      key: env.ELEVENLABS_API_KEY ?? '',
      voiceId: env.ELEVENLABS_VOICE_ID ?? '',
      model: env.ELEVENLABS_MODEL_ID || DEFAULTS.elevenLabsModel,
      baseUrl: env.ELEVENLABS_BASE_URL || DEFAULTS.elevenLabsBaseUrl,
    },
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Body is not valid JSON'), { status: 400 });
  }
}

/** Validate the one field every provider needs. */
function requireText(payload) {
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (text.length === 0) {
    throw Object.assign(new Error('Nothing to say: "text" is required'), { status: 400 });
  }
  if (text.length > MAX_TEXT_CHARS) {
    throw Object.assign(
      new Error(`Text is ${text.length} characters; the limit is ${MAX_TEXT_CHARS}`),
      { status: 413 },
    );
  }
  return text;
}

function pickId(value, fallback, label) {
  const chosen = typeof value === 'string' && value.length > 0 ? value : fallback;
  if (!chosen) return '';
  if (!SAFE_ID.test(chosen)) {
    throw Object.assign(new Error(`Invalid ${label}`), { status: 400 });
  }
  return chosen;
}

/** Pipe an upstream audio response through, mapping failures to plain language. */
async function relayAudio(res, upstream, providerLabel) {
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    const message =
      upstream.status === 401 || upstream.status === 403
        ? `${providerLabel} rejected the API key.`
        : upstream.status === 429
          ? `${providerLabel} is rate limiting; try again shortly.`
          : `${providerLabel} returned ${upstream.status}.`;
    // The upstream body can echo request detail, so it is truncated and never
    // allowed to carry anything of ours back out.
    sendJson(res, upstream.status === 401 ? 502 : upstream.status, {
      error: message,
      detail: detail.slice(0, 400),
    });
    return;
  }

  const audio = Buffer.from(await upstream.arrayBuffer());
  if (audio.length === 0) {
    sendJson(res, 502, { error: `${providerLabel} returned no audio.` });
    return;
  }
  res.writeHead(200, {
    'content-type': upstream.headers.get('content-type') ?? 'audio/mpeg',
    'content-length': String(audio.length),
    'cache-control': 'no-store',
  });
  res.end(audio);
}

export function createTtsProxy({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = readConfig(env);

  return async function handleTts(req, res, next) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/tts')) {
      if (next) return next();
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    try {
      if (url.pathname === '/api/tts/health') {
        sendJson(res, 200, {
          providers: {
            deepgram: config.deepgram.key
              ? { configured: true, detail: `Deepgram Aura — ${config.deepgram.model}` }
              : { configured: false, reason: 'DEEPGRAM_API_KEY is not set on the server.' },
            elevenlabs: config.elevenlabs.key
              ? {
                  configured: Boolean(config.elevenlabs.voiceId),
                  detail: `ElevenLabs — ${config.elevenlabs.voiceId}`,
                  ...(config.elevenlabs.voiceId
                    ? {}
                    : { reason: 'ELEVENLABS_VOICE_ID is not set on the server.' }),
                }
              : { configured: false, reason: 'ELEVENLABS_API_KEY is not set on the server.' },
          },
        });
        return;
      }

      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Use POST' });
        return;
      }

      const payload = await readJson(req);
      const text = requireText(payload);

      if (url.pathname === '/api/tts/deepgram') {
        if (!config.deepgram.key) {
          sendJson(res, 503, { error: 'DEEPGRAM_API_KEY is not set on the server.' });
          return;
        }
        const model = pickId(payload.model, config.deepgram.model, 'model');
        const target = new URL('/v1/speak', config.deepgram.baseUrl);
        target.searchParams.set('model', model);
        if (config.deepgram.encoding) target.searchParams.set('encoding', config.deepgram.encoding);
        if (config.deepgram.container) {
          target.searchParams.set('container', config.deepgram.container);
        }

        const upstream = await fetchImpl(target, {
          method: 'POST',
          headers: {
            authorization: `Token ${config.deepgram.key}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ text }),
        });
        await relayAudio(res, upstream, 'Deepgram');
        return;
      }

      if (url.pathname === '/api/tts/elevenlabs') {
        if (!config.elevenlabs.key) {
          sendJson(res, 503, { error: 'ELEVENLABS_API_KEY is not set on the server.' });
          return;
        }
        const voiceId = pickId(payload.voiceId, config.elevenlabs.voiceId, 'voiceId');
        if (!voiceId) {
          sendJson(res, 503, { error: 'ELEVENLABS_VOICE_ID is not set on the server.' });
          return;
        }
        const modelId = pickId(payload.modelId, config.elevenlabs.model, 'modelId');
        const target = new URL(`/v1/text-to-speech/${voiceId}`, config.elevenlabs.baseUrl);

        const upstream = await fetchImpl(target, {
          method: 'POST',
          headers: {
            'xi-api-key': config.elevenlabs.key,
            'content-type': 'application/json',
            accept: 'audio/mpeg',
          },
          body: JSON.stringify({ text, model_id: modelId }),
        });
        await relayAudio(res, upstream, 'ElevenLabs');
        return;
      }

      sendJson(res, 404, { error: 'Unknown speech route' });
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500;
      // Never let an upstream or internal message carry a credential outward.
      const message = status >= 500 ? 'The speech proxy failed.' : String(error.message);
      if (status >= 500) console.error('[tts-proxy]', error);
      sendJson(res, status, { error: message });
    }
  };
}

/** Vite plugin: the same handler in `vite dev` and `vite preview`. */
export function ttsProxyPlugin(options = {}) {
  const handler = createTtsProxy(options);
  return {
    name: 'jarvis-tts-proxy',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}
