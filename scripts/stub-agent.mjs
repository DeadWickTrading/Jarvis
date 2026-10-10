/**
 * A stand-in for the Deepgram Voice Agent, for testing without an account.
 *
 * It speaks no English and thinks about nothing, but it talks the protocol:
 * it accepts either credential form, answers Settings, scripts a full turn
 * when it hears audio, and sends its voice as raw little-endian PCM at the
 * configured rate. That exercises every link — token, handshake, settings,
 * microphone capture, upstream frames, event handling, PCM playback, the
 * orb's state machine — except Deepgram's own servers.
 *
 *   node scripts/stub-agent.mjs [port]
 */
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.argv[2]) || 8788;
const OUTPUT_RATE = 24_000;

const server = createServer((_req, res) => res.writeHead(426).end('websocket only'));

const wss = new WebSocketServer({
  server,
  /**
   * Subprotocol negotiation decides whether the handshake succeeds at all.
   *
   * A browser that offers protocols requires the server to select one of
   * them; selecting nothing fails the connection. Deepgram's documented form
   * is `token, <credential>`, so the first element is echoed back. When the
   * client offers nothing it is using the query-string form, and `false`
   * correctly selects no protocol.
   */
  handleProtocols: (protocols) => {
    for (const candidate of ['token', 'bearer']) {
      if (protocols.has(candidate)) return candidate;
    }
    return false;
  },
});

/** A second or so of speech-shaped PCM, as the agent's "voice". */
function agentVoice(seconds = 2.4) {
  const total = Math.round(seconds * OUTPUT_RATE);
  const pcm = Buffer.alloc(total * 2);
  const TAU = Math.PI * 2;

  for (let i = 0; i < total; i += 1) {
    const t = i / OUTPUT_RATE;
    const syllable = Math.pow(
      0.5 + 0.5 * Math.sin(t * TAU * 3.2 + 0.4 * Math.sin(t * TAU * 0.9)),
      1.6,
    );
    const envelope = syllable * Math.min(1, Math.max(0, 0.65 + 0.4 * Math.sin(t * TAU * 0.3))) * 0.5;
    const voice =
      Math.sin(t * TAU * 128) * 0.5 +
      Math.sin(t * TAU * 256) * 0.25 +
      Math.sin(t * TAU * 512) * 0.15 +
      Math.sin(t * TAU * 1024) * 0.08;

    const sample = Math.max(-1, Math.min(1, voice * envelope));
    pcm.writeInt16LE(Math.round(sample * (sample < 0 ? 32_768 : 32_767)), i * 2);
  }
  return pcm;
}

const VOICE = agentVoice();
/** 40ms chunks, as a real stream would arrive. */
const CHUNK_BYTES = Math.round(OUTPUT_RATE * 0.04) * 2;

wss.on('connection', (socket, request) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  const viaQuery = url.searchParams.has('access_token');
  const viaProtocol = Boolean(socket.protocol);
  // A relayed connection arrives with a header, exactly as a non-browser
  // client would — that is the whole point of relaying.
  const viaHeader = (request.headers.authorization ?? '').startsWith('Token ');
  console.log(
    `agent connection: ${
      viaHeader
        ? 'Authorization header (relayed)'
        : viaQuery
          ? 'query token'
          : viaProtocol
            ? `subprotocol "${socket.protocol}"`
            : 'no credential'
    }`,
  );

  if (!viaQuery && !viaProtocol && !viaHeader) {
    socket.close(1008, 'no credential');
    return;
  }

  const send = (payload) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
  };

  send({ type: 'Welcome', request_id: 'stub' });

  let audioBytes = 0;
  let turnInFlight = false;

  /** Script one full turn, with the timings a real exchange has. */
  const speak = async (userText, agentText) => {
    turnInFlight = true;
    send({ type: 'UserStartedSpeaking' });
    await delay(120);
    send({ type: 'ConversationText', role: 'user', content: userText });
    send({ type: 'AgentThinking' });
    await delay(450);
    send({ type: 'ConversationText', role: 'assistant', content: agentText });
    send({ type: 'AgentStartedSpeaking' });

    for (let offset = 0; offset < VOICE.length; offset += CHUNK_BYTES) {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(VOICE.subarray(offset, Math.min(offset + CHUNK_BYTES, VOICE.length)));
      await delay(25);
    }
    send({ type: 'AgentAudioDone' });
    turnInFlight = false;
  };

  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      audioBytes += data.length;
      // Roughly a second of microphone audio, then answer — the same shape a
      // real end-of-turn detection produces.
      if (!turnInFlight && audioBytes > 48_000 * 2) {
        audioBytes = 0;
        void speak('What do you need?', 'Standing by, sir.');
      }
      return;
    }

    let message;
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }

    if (message.type === 'Settings') {
      console.log(
        `settings: input ${message.audio?.input?.sample_rate}Hz, output ${message.audio?.output?.sample_rate}Hz, speak ${message.agent?.speak?.provider?.model}`,
      );
      send({ type: 'SettingsApplied' });
      // The greeting, as the real agent does on connect.
      void speak('', message.agent?.greeting ?? 'Hello.');
      return;
    }

    if (message.type === 'KeepAlive') return;

    if (message.type === 'FunctionCallResponse') {
      console.log(`function response: ${message.name}`);
    }
  });

  socket.on('close', () => console.log('agent connection closed'));
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

server.listen(PORT, '127.0.0.1', () => {
  console.log(`stub Voice Agent listening on ws://127.0.0.1:${PORT}`);
});
