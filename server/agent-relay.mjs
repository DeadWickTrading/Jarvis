/**
 * Relay the Voice Agent socket through this server.
 *
 * The browser cannot hold the API key, and it cannot set an Authorization
 * header on a WebSocket either. The usual answer is to mint a short-lived
 * token — but Deepgram's /v1/auth/grant needs a key with Member permissions
 * or higher, while the same key works fine for everything else. A key that
 * demonstrably synthesises speech can still be refused a token, which leaves
 * the conversation dead for a reason that has nothing to do with the code.
 *
 * Relaying sidesteps all of it. The browser opens a plain same-origin socket
 * with no credential at all; this server opens the upstream one with the key
 * in a header, where headers are allowed, and copies frames between them. No
 * token, no permission level, no ambiguity about which credential form the
 * handshake wants — and the key never leaves the machine it is stored on,
 * not even as something short-lived.
 */
import { WebSocket, WebSocketServer } from 'ws';

export const RELAY_PATH = '/api/agent/socket';

const DEFAULT_UPSTREAM = 'wss://agent.deepgram.com/v1/agent/converse';

export function createAgentRelay({ env = process.env } = {}) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (client) => {
    const key = env.DEEPGRAM_API_KEY ?? '';
    const upstreamUrl = env.DEEPGRAM_AGENT_URL || DEFAULT_UPSTREAM;

    let upstream;
    try {
      upstream = new WebSocket(upstreamUrl, { headers: { Authorization: `Token ${key}` } });
    } catch (error) {
      console.error('[agent-relay] could not open upstream:', error);
      client.close(1011, 'upstream unavailable');
      return;
    }

    /**
     * The client sends its Settings message the instant its own socket opens,
     * which is well before the upstream handshake has finished. Those frames
     * are held rather than dropped — losing Settings means the agent never
     * starts, with nothing on either side to say why.
     */
    const pending = [];

    upstream.on('open', () => {
      for (const { data, isBinary } of pending) upstream.send(data, { binary: isBinary });
      pending.length = 0;
    });

    client.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else if (upstream.readyState === WebSocket.CONNECTING) pending.push({ data, isBinary });
    });

    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });

    // Either side going away ends both, so a half-open socket cannot linger
    // and leave the orb waiting on a conversation that is over.
    const closeBoth = (code, reason) => {
      // 1005 and 1006 are "no status" codes a server may not send onward.
      const safe = code && code >= 1000 && code !== 1005 && code !== 1006 ? code : 1000;
      if (client.readyState === WebSocket.OPEN) client.close(safe, reason);
      if (upstream.readyState === WebSocket.OPEN) upstream.close(safe, reason);
    };

    client.on('close', (code, reason) => closeBoth(code, String(reason ?? '')));
    upstream.on('close', (code, reason) => closeBoth(code, String(reason ?? '')));

    client.on('error', () => closeBoth(1011, 'client error'));
    upstream.on('error', (error) => {
      console.error('[agent-relay] upstream error:', error.message);
      closeBoth(1011, 'upstream error');
    });
  });

  return {
    /**
     * Handle an HTTP upgrade. Returns true when it was ours.
     *
     * Returning false rather than destroying the socket matters: the dev
     * server runs its own hot-reload WebSocket on the same port, and
     * swallowing that upgrade would break reloading entirely.
     */
    handleUpgrade(request, socket, head) {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname !== RELAY_PATH) return false;

      if (!(env.DEEPGRAM_API_KEY ?? '')) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        socket.destroy();
        return true;
      }

      wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
      return true;
    },

    close() {
      wss.close();
    },
  };
}
