import type { AudioSink, SpeakerScene } from '../types.js';
import { createMicCapture, type MicCapture } from './capture.js';
import { connectAgent, type AgentAuthStrategy, type AgentConnection } from './connection.js';
import { createPcmPlayer, type PcmPlayer } from './playback.js';
import { IDLE_STATUS, resolveOrbState, type AgentStatus } from './state.js';

export interface VoiceAgentOptions {
  readonly scene: SpeakerScene;
  /** Where the agent's voice goes so the orb can ride it. */
  readonly sink: AudioSink;
  /** The Deepgram Settings message. The input sample rate is corrected for you. */
  readonly settings: Record<string, unknown>;
  readonly url?: string;
  readonly tokenEndpoint?: string;
  readonly strategies?: readonly AgentAuthStrategy[];
  readonly onTranscript?: (role: string, text: string) => void;
  readonly onStatus?: (status: AgentStatus) => void;
  readonly onInfo?: (message: string) => void;
  readonly onError?: (error: Error) => void;
  /**
   * Client-side tools, by function name. Each gets the parsed arguments and
   * returns the text the model sees. `end_conversation` is built in.
   */
  readonly functions?: Readonly<Record<string, (args: Record<string, unknown>) => Promise<string> | string>>;
}

export interface VoiceAgent {
  /** The latch. On until switched off; nothing is held down. */
  setMicOpen(open: boolean): Promise<void>;
  toggleMic(): Promise<void>;
  /** Close the microphone and the socket. */
  end(): void;
  readonly status: AgentStatus;
}

/** Sample rate the agent is told to send its voice at. */
function outputSampleRate(settings: Record<string, unknown>): number {
  const audio = settings.audio as { output?: { sample_rate?: number } } | undefined;
  return audio?.output?.sample_rate ?? 24_000;
}

/**
 * A live conversation with the Deepgram Voice Agent, wired to the orb.
 *
 * The microphone is a latch rather than a hold: switched on it stays on, and
 * it stays on across the agent's replies so a conversation can continue
 * without touching anything. Switching it off stops the capture *and the
 * media tracks*, so the browser's recording indicator goes out. Leaving the
 * stream open and merely ignoring its frames would be less work and a quieter
 * lie: the light would stay on while the thing claimed not to be listening.
 *
 * The socket stays open while the mic is shut, kept alive, so switching back
 * on is instant and the conversation keeps its context. `end()` closes both.
 */
export function createVoiceAgent(options: VoiceAgentOptions): VoiceAgent {
  const { scene, sink } = options;

  let status: AgentStatus = { ...IDLE_STATUS };
  let connection: AgentConnection | null = null;
  let capture: MicCapture | null = null;
  let stream: MediaStream | null = null;
  let player: PcmPlayer | null = null;
  /** Guards against two toggles racing each other. */
  let pending: Promise<void> | null = null;

  function update(changes: Partial<AgentStatus>): void {
    status = { ...status, ...changes };
    scene.setState(resolveOrbState(status));
    options.onStatus?.(status);
  }

  function fail(error: Error): void {
    options.onError?.(error);
    update({ connection: 'failed' });
  }

  function teardownMic(): void {
    capture?.dispose();
    capture = null;
    // Stop the tracks, not just the capture: this is what puts the browser's
    // recording indicator out, which is the whole point of a latch the user
    // can see the state of.
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
  }

  function handleEvent(event: Record<string, unknown>): void {
    const type = String(event.type ?? '');

    switch (type) {
      case 'Welcome':
      case 'SettingsApplied':
        options.onInfo?.(type === 'Welcome' ? 'Agent connected.' : 'Settings accepted.');
        break;

      case 'UserStartedSpeaking':
        // Barge-in: the server has already abandoned the agent's turn, so
        // anything still queued locally would be talking over the user.
        player?.clear();
        update({ agentSpeaking: false, agentThinking: false });
        break;

      case 'AgentThinking':
        update({ agentThinking: true });
        break;

      case 'ConversationText': {
        const role = String(event.role ?? 'assistant');
        const content = String(event.content ?? '');
        if (content) options.onTranscript?.(role, content);
        break;
      }

      case 'AgentStartedSpeaking':
        // Audio has not necessarily arrived yet; `agentSpeaking` flips when
        // the player actually begins, so the orb matches what is audible.
        update({ agentThinking: false });
        break;

      case 'AgentAudioDone':
        // Deliberately not treated as the end of the agent's voice. Deepgram
        // documents this as "the last chunk has been sent", and chunks
        // already received are still sitting in the local queue. The orb
        // leaves `speaking` when the player drains, not here.
        break;

      case 'FunctionCallRequest':
        handleFunctionCall(event);
        break;

      case 'Error':
      case 'Warning':
        fail(new Error(String(event.description ?? event.message ?? 'Agent reported an error')));
        break;

      default:
        // Unknown events are logged, never fatal: Deepgram adds new ones.
        options.onInfo?.(`Agent event: ${type || 'unnamed'}`);
    }
  }

  /**
   * Answer a tool call.
   *
   * The only function configured is `end_conversation`, which the prompt uses
   * to let Jarwick stand down when asked to stop. That closes the latch, which
   * is exactly what the user would otherwise do by hand.
   *
   * The response shape follows Deepgram's documented FunctionCallResponse.
   * It is echoed back with whatever id and name arrived, so a change to their
   * schema degrades to an ignored message rather than a crash.
   */
  function handleFunctionCall(event: Record<string, unknown>): void {
    const functions = Array.isArray(event.functions) ? event.functions : [event];
    for (const entry of functions as Record<string, unknown>[]) {
      const name = String(entry.name ?? event.function_name ?? '');
      const id = entry.id ?? event.function_call_id ?? event.id;
      const reply = (content: string): void => {
        connection?.send({ type: 'FunctionCallResponse', id, name, content });
      };

      if (name === 'end_conversation') {
        reply(JSON.stringify({ ok: true }));
        options.onInfo?.('Jarwick ended the conversation.');
        void setMicOpen(false);
        continue;
      }

      const handler = options.functions?.[name];
      if (!handler) {
        reply(JSON.stringify({ ok: false, error: `No tool called ${name} here.` }));
        continue;
      }
      let args: Record<string, unknown> = {};
      try {
        const raw = entry.arguments ?? entry.input ?? '{}';
        args = typeof raw === 'string' ? (JSON.parse(raw || '{}') as Record<string, unknown>) : (raw as Record<string, unknown>);
      } catch {
        args = {};
      }
      Promise.resolve()
        .then(() => handler(args))
        .then(
          (text) => reply(String(text)),
          (error: unknown) => reply(`Tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`),
        );
    }
  }

  async function ensureConnection(): Promise<AgentConnection> {
    if (connection?.open) return connection;

    update({ connection: 'connecting' });
    const context = sink.context();
    if (context.state === 'suspended') await context.resume();

    player ??= createPcmPlayer({
      context,
      sampleRate: outputSampleRate(options.settings),
      onStarted: () => update({ agentSpeaking: true }),
      onDrained: () => update({ agentSpeaking: false }),
    });
    // The orb taps the agent's voice, not the microphone: the galaxy answers
    // the AI, not the user.
    sink.attach(player.node);

    // Declare the rate the microphone will actually arrive at. An
    // AudioContext is 44100 on plenty of hardware, and sending 44.1k while
    // claiming 48k makes the agent hear a chipmunk and transcribe nonsense.
    const settings = structuredClone(options.settings) as Record<string, unknown>;
    const audio = (settings.audio ??= {}) as Record<string, unknown>;
    const input = (audio.input ??= {}) as Record<string, unknown>;
    if (input.sample_rate !== context.sampleRate) {
      options.onInfo?.(
        `Microphone runs at ${context.sampleRate}Hz; telling the agent so rather than resampling.`,
      );
    }
    input.sample_rate = context.sampleRate;
    input.encoding ??= 'linear16';

    const opened = await connectAgent({
      ...(options.url ? { url: options.url } : {}),
      ...(options.tokenEndpoint ? { tokenEndpoint: options.tokenEndpoint } : {}),
      ...(options.strategies ? { strategies: options.strategies } : {}),
      settings,
      onEvent: handleEvent,
      onAudio: (bytes) => player?.enqueue(bytes),
      onClosed: ({ code, reason, clean }) => {
        connection = null;
        teardownMic();
        if (clean || code === 1000) {
          update({ connection: 'closed', micOpen: false, agentSpeaking: false });
        } else {
          options.onError?.(new Error(`Agent socket closed (${code}${reason ? `: ${reason}` : ''})`));
          update({ connection: 'failed', micOpen: false, agentSpeaking: false });
        }
      },
    });

    connection = opened;
    options.onInfo?.(
      opened.strategy === 'relay'
        ? 'Connected through the server relay — no credential in the browser.'
        : `Connected directly using the ${opened.strategy} credential form.`,
    );
    update({ connection: 'open' });
    return opened;
  }

  async function setMicOpen(open: boolean): Promise<void> {
    if (open === status.micOpen && !status.micArming) return;

    if (!open) {
      teardownMic();
      update({ micOpen: false, micArming: false });
      return;
    }

    update({ micArming: true, connection: status.connection === 'failed' ? 'closed' : status.connection });
    try {
      const live = await ensureConnection();
      const context = sink.context();

      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });

      capture = await createMicCapture({
        context,
        stream,
        onFrame: (pcm) => live.sendAudio(pcm),
      });

      update({ micOpen: true, micArming: false });
    } catch (error) {
      teardownMic();
      update({ micOpen: false, micArming: false });
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  return {
    get status() {
      return status;
    },

    async setMicOpen(open: boolean): Promise<void> {
      // Serialise: double-tapping the latch must not leave two streams open.
      const run = (pending ?? Promise.resolve()).then(() => setMicOpen(open));
      pending = run.catch(() => undefined);
      return run;
    },

    async toggleMic(): Promise<void> {
      await this.setMicOpen(!status.micOpen);
    },

    end(): void {
      teardownMic();
      connection?.close();
      connection = null;
      player?.dispose();
      player = null;
      sink.attach(null);
      update({ ...IDLE_STATUS });
    },
  };
}
