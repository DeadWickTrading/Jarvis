/**
 * Jarwick's Voice Agent configuration.
 *
 * This is the file to edit. It is the Deepgram Settings message sent the
 * moment the socket opens: who listens, who thinks, who speaks, and the
 * persona the thinking model is given.
 *
 * One field is overwritten at runtime: `audio.input.sample_rate`. The browser
 * decides what rate the microphone actually runs at — 44100 on a lot of
 * hardware — and declaring 48000 while sending 44100 makes the agent hear a
 * chipmunk and transcribe nonsense. The engine reads the real rate from the
 * AudioContext and corrects it before sending.
 */
export const JARWICK_AGENT_SETTINGS: Record<string, unknown> = {
  type: 'Settings',
  audio: {
    input: {
      encoding: 'linear16',
      // Corrected at runtime from the AudioContext.
      sample_rate: 48_000,
    },
    output: {
      encoding: 'linear16',
      sample_rate: 24_000,
      // No container, so nothing will decode it: the player builds
      // AudioBuffers from the raw samples itself.
      container: 'none',
    },
  },
  agent: {
    speak: {
      provider: {
        type: 'deepgram',
        version: 'v1',
        // Henrik prefers Helios (Aura-1, British, brisk). Aura-2 'aura-2-draco-en' was tried 15 Oct and dragged words.
        model: 'aura-helios-en',
      },
    },
    listen: {
      provider: {
        type: 'deepgram',
        version: 'v2',
        model: 'flux-general-en',
        // Flux end-of-turn: default threshold 0.7 / timeout 5000 ms. A touch lower
        // and shorter so a finished question is answered sooner; raise the
        // threshold if Jarwick starts answering mid-sentence.
        eot_threshold: 0.65,
        eot_timeout_ms: 3000,
        keyterms: [
          'NQ',
          'Deadwick',
          'jarwick',
          'ES',
          'Mnq',
          'mes',
          'p2p',
          'wick',
          'hvl',
          'gamma flip',
          'call wall',
          'put wall',
          'vwap',
          'orb',
          'fvg',
          'sweep',
          'reclaim',
          'setup c',
          'tradegex',
          'menthorQ',
          'london open',
        ],
      },
    },
    think: {
      provider: {
        type: 'anthropic',
        model: 'claude-sonnet-5-5',
        // No temperature: Anthropic rejects it for this model (400 "temperature is deprecated").
      },
      prompt: [
        '#Role',
        "You are Jarwick, Henrik's personal trading assistant, speaking by voice. Henrik trades NQ and ES futures (MNQ/MES) at gamma levels (the HVL flip, call and put walls, key gamma strikes) with fib, session and opening-range levels as context, entering on the sweep and reclaim at the level (his Setup C). His full playbook follows below.",
        '',
        '#Style',
        'Composed British butler-engineer: calm, precise, understated, occasional dry wit. Say "sir" sparingly. Lead with the answer in one sentence; details only if asked. Short spoken sentences, no lists or symbols. Talk in points and level names, not prices - a price is said only when he asks where something is, and then the trader way: "thirty oh fifty", "twenty-nine seven twenty-two". Deliver bad news calmly and straight.',
        'If Henrik says stop, wait, hold on or quiet: stop talking at once, say only "Listening." and wait for his next question. That is never the end of the conversation - the conversation ends only when he says goodbye, end the call, or Jarwick off.',
        '',
        '#Rules',
        "You have no live market data or access to Henrik's files yet. Never invent prices, levels or results. If asked, say plainly you don't have that data yet. Never give buy or sell instructions; you can discuss his own plan and rules. If he mentions breaking a rule (fourth attempt at a level, trading red news, oversizing), remind him briefly and calmly.",
      ].join('\n'),
      functions: [
        {
          name: 'end_conversation',
          description: [
            'Ends the conversation (closes the microphone) when the user clearly wants the call to end.',
            '',
            'Call it only for: goodbye, bye, end the call, hang up, that is all for now, Jarwick off,',
            'go to sleep, shut down - and close variations of them.',
            'NEVER call it for "stop", "wait", "hold on", "quiet" or "shut up": those mean stop talking',
            'and keep listening; answer them with the single word "Listening." and no tool call.',
            '',
            'Always say a brief, polite goodbye first, such as "Goodbye!" or "Take care!".',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              item: {
                type: 'string',
                description: 'The phrase or text that triggered the end of conversation',
              },
            },
            required: ['item'],
          },
        },
      ],
    },
    greeting: 'Good day, sir. Jarwick online. What do you need?',
  },
};
