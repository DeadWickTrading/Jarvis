import { describe, expect, it, vi } from 'vitest';
// The proxy is plain Node, deliberately framework-free so it can be Vite
// middleware in dev and a route in any server in production.
import { createTtsProxy } from '../../../server/speech-proxy.mjs';
import type { UpstreamResponse } from '../../../server/speech-proxy.mjs';

const KEY = 'super-secret-key-do-not-leak';

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  json(): unknown;
}

/** Drive the handler with a fake request and capture what it wrote. */
async function call(
  handler: (req: unknown, res: unknown, next?: () => void) => Promise<void>,
  options: { url: string; method?: string; body?: unknown },
): Promise<Captured> {
  const payload = options.body === undefined ? '' : JSON.stringify(options.body);
  const listeners: Record<string, ((chunk?: Buffer) => void)[]> = {};

  const req = {
    url: options.url,
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: {},
    destroy: () => undefined,
    on(event: string, fn: (chunk?: Buffer) => void) {
      (listeners[event] ??= []).push(fn);
      return req;
    },
  };

  const chunks: Buffer[] = [];
  let status = 0;
  let headers: Record<string, string> = {};
  const res = {
    writeHead(code: number, head: Record<string, string> = {}) {
      status = code;
      headers = head;
      return res;
    },
    end(body?: string | Buffer) {
      if (body) chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(body));
    },
  };

  const pending = handler(req, res);
  // Deliver the body on the next tick, once the handler has subscribed.
  await Promise.resolve();
  for (const fn of listeners.data ?? []) if (payload) fn(Buffer.from(payload));
  for (const fn of listeners.end ?? []) fn();
  await pending;

  const body = Buffer.concat(chunks);
  return {
    status,
    headers,
    body,
    json: () => JSON.parse(body.toString('utf8')),
  };
}

/** The arguments the proxy calls fetch with, so mock.calls is a known tuple. */
type FetchArgs = [url: URL | string, init: RequestInit];
const mockFetch = (impl: (...args: FetchArgs) => Promise<UpstreamResponse>) => vi.fn(impl);

const audioResponse = (bytes = Buffer.from('RIFFfake')): UpstreamResponse => ({
  ok: true,
  status: 200,
  headers: new Headers({ 'content-type': 'audio/wav' }),
  arrayBuffer: async () => new Uint8Array(bytes).buffer,
  text: async () => '',
});

describe('the speech proxy', () => {
  describe('health', () => {
    it('reports a provider as configured only when it has a key', async () => {
      const handler = createTtsProxy({ env: { DEEPGRAM_API_KEY: KEY }, fetchImpl: vi.fn() });
      const res = await call(handler, { url: '/api/tts/health' });
      const report = res.json() as { providers: Record<string, { configured: boolean }> };

      expect(res.status).toBe(200);
      expect(report.providers.deepgram.configured).toBe(true);
      expect(report.providers.elevenlabs.configured).toBe(false);
    });

    it('explains what is missing rather than just saying no', async () => {
      const handler = createTtsProxy({ env: {}, fetchImpl: vi.fn() });
      const report = (await call(handler, { url: '/api/tts/health' })).json() as {
        providers: Record<string, { reason?: string }>;
      };
      expect(report.providers.deepgram.reason).toMatch(/DEEPGRAM_API_KEY/);
      expect(report.providers.elevenlabs.reason).toMatch(/ELEVENLABS_API_KEY/);
    });

    it('never puts the key in the health report', async () => {
      const handler = createTtsProxy({ env: { DEEPGRAM_API_KEY: KEY }, fetchImpl: vi.fn() });
      const res = await call(handler, { url: '/api/tts/health' });
      expect(res.body.toString('utf8')).not.toContain(KEY);
    });
  });

  describe('deepgram', () => {
    it('forwards the text and attaches the key server-side', async () => {
      const fetchImpl = mockFetch(async () => audioResponse());
      const handler = createTtsProxy({
        env: { DEEPGRAM_API_KEY: KEY, DEEPGRAM_BASE_URL: 'https://example.test' },
        fetchImpl,
      });

      const res = await call(handler, {
        url: '/api/tts/deepgram',
        body: { text: 'Good day, sir.' },
      });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('audio/wav');

      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(String(url)).toBe('https://example.test/v1/speak?model=aura-helios-en');
      expect(init.headers).toMatchObject({ authorization: `Token ${KEY}` });
      expect(JSON.parse(String(init.body))).toEqual({ text: 'Good day, sir.' });
    });

    it('defaults to the British Aura voice the agent config uses', async () => {
      const fetchImpl = mockFetch(async () => audioResponse());
      const handler = createTtsProxy({ env: { DEEPGRAM_API_KEY: KEY }, fetchImpl });
      await call(handler, { url: '/api/tts/deepgram', body: { text: 'hello' } });
      expect(String(fetchImpl.mock.calls[0]![0])).toContain('model=aura-helios-en');
    });

    it('refuses a model id that is not a plain identifier', async () => {
      const fetchImpl = mockFetch(async () => audioResponse());
      const handler = createTtsProxy({ env: { DEEPGRAM_API_KEY: KEY }, fetchImpl });
      const res = await call(handler, {
        url: '/api/tts/deepgram',
        body: { text: 'hello', model: '../../v1/projects?x=' },
      });
      expect(res.status).toBe(400);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('says so plainly when no key is configured', async () => {
      const handler = createTtsProxy({ env: {}, fetchImpl: vi.fn() });
      const res = await call(handler, { url: '/api/tts/deepgram', body: { text: 'hello' } });
      expect(res.status).toBe(503);
      expect((res.json() as { error: string }).error).toMatch(/DEEPGRAM_API_KEY/);
    });

    it('rejects empty text before spending a request', async () => {
      const fetchImpl = vi.fn();
      const handler = createTtsProxy({ env: { DEEPGRAM_API_KEY: KEY }, fetchImpl });
      for (const body of [{}, { text: '' }, { text: '   ' }, { text: 42 }]) {
        const res = await call(handler, { url: '/api/tts/deepgram', body });
        expect(res.status).toBe(400);
      }
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('rejects over-long text locally, as Deepgram would with a 413', async () => {
      const fetchImpl = vi.fn();
      const handler = createTtsProxy({ env: { DEEPGRAM_API_KEY: KEY }, fetchImpl });
      const res = await call(handler, {
        url: '/api/tts/deepgram',
        body: { text: 'x'.repeat(2001) },
      });
      expect(res.status).toBe(413);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('turns a rejected key into a message about the key, without echoing it', async () => {
      const fetchImpl = mockFetch(async () => ({
        ok: false,
        status: 401,
        headers: new Headers(),
        text: async () => `{"err_msg":"Invalid credentials for ${KEY}"}`,
        arrayBuffer: async () => new ArrayBuffer(0),
      }));
      const handler = createTtsProxy({ env: { DEEPGRAM_API_KEY: KEY }, fetchImpl });
      const res = await call(handler, { url: '/api/tts/deepgram', body: { text: 'hello' } });

      expect(res.status).toBe(502);
      expect((res.json() as { error: string }).error).toMatch(/rejected the API key/i);
    });

    it('does not pass off an empty upstream body as audio', async () => {
      const fetchImpl = mockFetch(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'audio/wav' }),
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => '',
      }));
      const handler = createTtsProxy({ env: { DEEPGRAM_API_KEY: KEY }, fetchImpl });
      const res = await call(handler, { url: '/api/tts/deepgram', body: { text: 'hello' } });
      expect(res.status).toBe(502);
    });
  });

  describe('elevenlabs', () => {
    it('needs both a key and a voice before it will claim to be configured', async () => {
      const keyOnly = createTtsProxy({ env: { ELEVENLABS_API_KEY: KEY }, fetchImpl: vi.fn() });
      const report = (await call(keyOnly, { url: '/api/tts/health' })).json() as {
        providers: Record<string, { configured: boolean; reason?: string }>;
      };
      expect(report.providers.elevenlabs.configured).toBe(false);
      expect(report.providers.elevenlabs.reason).toMatch(/VOICE_ID/);
    });

    it('sends the key in the header ElevenLabs expects', async () => {
      const fetchImpl = mockFetch(async () => audioResponse());
      const handler = createTtsProxy({
        env: {
          ELEVENLABS_API_KEY: KEY,
          ELEVENLABS_VOICE_ID: 'abc123',
          ELEVENLABS_BASE_URL: 'https://eleven.test',
        },
        fetchImpl,
      });
      await call(handler, { url: '/api/tts/elevenlabs', body: { text: 'hello' } });

      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(String(url)).toBe('https://eleven.test/v1/text-to-speech/abc123');
      expect(init.headers).toMatchObject({ 'xi-api-key': KEY });
    });
  });

  describe('routing', () => {
    it('passes non-speech paths to the next handler', async () => {
      const handler = createTtsProxy({ env: {}, fetchImpl: vi.fn() });
      const next = vi.fn();
      await (handler as unknown as (r: unknown, s: unknown, n: () => void) => Promise<void>)(
        { url: '/index.html', method: 'GET', headers: {}, on: () => undefined },
        { writeHead: () => undefined, end: () => undefined },
        next,
      );
      expect(next).toHaveBeenCalledOnce();
    });

    it('refuses a GET on a speak route rather than treating it as empty text', async () => {
      const handler = createTtsProxy({ env: { DEEPGRAM_API_KEY: KEY }, fetchImpl: vi.fn() });
      const res = await call(handler, { url: '/api/tts/deepgram', method: 'GET' });
      expect(res.status).toBe(405);
    });
  });
});
