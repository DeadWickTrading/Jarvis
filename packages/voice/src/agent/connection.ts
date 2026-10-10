/**
 * The Voice Agent WebSocket.
 *
 * A browser cannot set an Authorization header on a WebSocket handshake, so
 * the credential has to travel another way. Deepgram documents the
 * Sec-WebSocket-Protocol route for API keys, and community reports say a
 * short-lived JWT has to go in the query string instead. Rather than pick one
 * and hope, this tries each in turn and reports which worked — a browser
 * gives back nothing but close code 1006 on a rejected handshake, so guessing
 * wrong is otherwise an afternoon of silence with no error to read.
 */

export type AgentAuthStrategy = 'query' | 'token-subprotocol' | 'bearer-subprotocol';

export const DEFAULT_AGENT_URL = 'wss://agent.deepgram.com/v1/agent/converse';

/** The order to try. Query first: that is what a JWT is reported to need. */
export const DEFAULT_AUTH_STRATEGIES: readonly AgentAuthStrategy[] = [
  'query',
  'token-subprotocol',
  'bearer-subprotocol',
];

export interface AgentConnectionOptions {
  readonly url?: string;
  /** Route on our own server that mints a short-lived token. */
  readonly tokenEndpoint?: string;
  /** The Settings message, sent the moment the socket opens. */
  readonly settings: unknown;
  readonly strategies?: readonly AgentAuthStrategy[];
  /** How long to wait for a handshake before trying the next strategy. */
  readonly handshakeTimeoutMs?: number;
  /** Silence after which the server may hang up; a KeepAlive goes out sooner. */
  readonly keepAliveMs?: number;
  readonly onEvent: (event: Record<string, unknown>) => void;
  readonly onAudio: (bytes: ArrayBuffer) => void;
  readonly onClosed: (info: { code: number; reason: string; clean: boolean }) => void;
}

export interface AgentConnection {
  send(message: unknown): void;
  /** Send a block of microphone PCM. Dropped silently when not open. */
  sendAudio(pcm: Int16Array): void;
  close(): void;
  readonly open: boolean;
  /** Which auth form the server accepted, for reporting and for next time. */
  readonly strategy: AgentAuthStrategy;
}

interface TokenResponse {
  access_token?: string;
  error?: string;
  /** Whatever the upstream said, which is usually the specific reason. */
  detail?: string;
}

async function mintToken(endpoint: string): Promise<string> {
  const response = await fetch(endpoint, { method: 'POST' });
  const body = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || !body.access_token) {
    const reason = body.error ?? `Could not mint an agent token (${response.status}).`;
    // Deepgram's own message is what actually identifies the problem;
    // dropping it leaves the user guessing between a wrong key and a key
    // without the right permissions.
    throw new Error(body.detail ? `${reason} Deepgram said: ${body.detail}` : reason);
  }
  return body.access_token;
}

/** Build the URL and subprotocols for one strategy. */
function buildHandshake(
  baseUrl: string,
  token: string,
  strategy: AgentAuthStrategy,
): { url: string; protocols?: string[] } {
  switch (strategy) {
    case 'query': {
      const url = new URL(baseUrl);
      url.searchParams.set('access_token', token);
      return { url: url.toString() };
    }
    case 'token-subprotocol':
      return { url: baseUrl, protocols: ['token', token] };
    case 'bearer-subprotocol':
      return { url: baseUrl, protocols: ['bearer', token] };
  }
}

/** Open one socket, or reject so the next strategy can be tried. */
function attempt(
  baseUrl: string,
  token: string,
  strategy: AgentAuthStrategy,
  timeoutMs: number,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const { url, protocols } = buildHandshake(baseUrl, token, strategy);
    const socket = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
    socket.binaryType = 'arraybuffer';

    const timer = setTimeout(() => {
      cleanup();
      socket.close();
      reject(new Error(`${strategy}: handshake timed out`));
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('error', onError);
    };

    const onOpen = (): void => {
      cleanup();
      resolve(socket);
    };
    // A rejected handshake surfaces as a close with 1006 and no reason, which
    // is indistinguishable from a network failure. Either way, try the next.
    const onClose = (event: CloseEvent): void => {
      cleanup();
      reject(new Error(`${strategy}: closed before opening (${event.code})`));
    };
    const onError = (): void => {
      cleanup();
      reject(new Error(`${strategy}: handshake failed`));
    };

    socket.addEventListener('open', onOpen);
    socket.addEventListener('close', onClose);
    socket.addEventListener('error', onError);
  });
}

export async function connectAgent(options: AgentConnectionOptions): Promise<AgentConnection> {
  const baseUrl = options.url ?? DEFAULT_AGENT_URL;
  const strategies = options.strategies ?? DEFAULT_AUTH_STRATEGIES;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 6000;
  const keepAliveMs = options.keepAliveMs ?? 5000;

  const token = await mintToken(options.tokenEndpoint ?? '/api/agent/token');

  let socket: WebSocket | null = null;
  let strategy: AgentAuthStrategy = strategies[0]!;
  const failures: string[] = [];

  for (const candidate of strategies) {
    try {
      socket = await attempt(baseUrl, token, candidate, handshakeTimeoutMs);
      strategy = candidate;
      break;
    } catch (error) {
      failures.push((error as Error).message);
    }
  }

  if (!socket) {
    throw new Error(
      `Could not open the Voice Agent socket. Tried: ${failures.join('; ')}. ` +
        'If one of these is the right form, pin it with the strategies option.',
    );
  }

  const live = socket;
  live.addEventListener('message', (event: MessageEvent) => {
    if (typeof event.data === 'string') {
      try {
        options.onEvent(JSON.parse(event.data) as Record<string, unknown>);
      } catch {
        // A message we cannot parse is not worth taking the session down for.
        options.onEvent({ type: 'Unparseable', raw: event.data });
      }
      return;
    }
    if (event.data instanceof ArrayBuffer) options.onAudio(event.data);
  });

  // The server hangs up on a silent client, and the mic latch means long
  // stretches with nothing to send are normal rather than exceptional.
  const keepAlive = setInterval(() => {
    if (live.readyState === WebSocket.OPEN) live.send(JSON.stringify({ type: 'KeepAlive' }));
  }, keepAliveMs);

  live.addEventListener('close', (event: CloseEvent) => {
    clearInterval(keepAlive);
    options.onClosed({ code: event.code, reason: event.reason, clean: event.wasClean });
  });

  live.send(JSON.stringify(options.settings));

  return {
    strategy,
    get open() {
      return live.readyState === WebSocket.OPEN;
    },
    send(message) {
      if (live.readyState === WebSocket.OPEN) live.send(JSON.stringify(message));
    },
    sendAudio(pcm) {
      if (live.readyState !== WebSocket.OPEN) return;
      live.send(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
    },
    close() {
      clearInterval(keepAlive);
      if (live.readyState === WebSocket.OPEN || live.readyState === WebSocket.CONNECTING) {
        live.close(1000, 'client closed');
      }
    },
  };
}
