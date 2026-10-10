# Handing this over

Everything built in this repo, where it lives, and what another developer —
or another Claude — needs to know to put the orb into an existing page.

Start with `README.md` for what the thing *is*. This file is about using it
somewhere else.

---

## 1. The map

```
packages/orb-engine/      The scene. Framework-free TypeScript + three.js.
  src/brand.ts            Single source of every colour in the system.
  src/states.ts           THE state table: every visual parameter, all six states.
  src/easing.ts           Frame-rate independent easing.
  src/layout.ts           Seeded galaxy layout (pure).
  src/perf.ts             Frame-rate watchdog (pure).
  src/audio/              Band maths, synthetic envelope, non-destructive taps.
  src/scene/              three.js: engine (one context, three passes), sky,
                          network, orb. Only ever draws numbers computed above.

packages/voice/           Speech and conversation.
  src/browser.ts          OS speech synthesis. Free, no key, NO audio stream.
  src/deepgram.ts         Deepgram Aura via the proxy. Real waveform.
  src/elevenlabs.ts       Same rails, unverified — no key was available.
  src/speaker.ts          Drives the orb's states from a voice.
  src/agent/              The Voice Agent: socket, mic capture, PCM playback,
                          and the pure state resolver that maps it to the orb.
  src/standalone.ts       Entry for the one-file bundle (three.js inlined).

server/
  speech-proxy.mjs        TTS relay + agent token minting. Plain Node, no build.
  agent-relay.mjs         Relays the agent WebSocket so no credential reaches
                          the browser. This is the default path.

apps/demo/                The reference implementation — read this to see how
  src/main.ts             the pieces fit together.
  src/agent-settings.ts   Jarvis's persona, voices and keyterms. EDIT HERE.

examples/embed.html       The minimal integration. Copy this.
scripts/                  Token generation, screenshot harness, test stubs.
```

## 2. Three levels of integration

Pick the smallest one that does what you need.

### Level 1 — the orb only. No server, no key.

The scene with no voice: you tell it what state to be in, it looks alive.
This is a static file and nothing else.

```bash
npm ci
npm run build -w @deadwick/orb-engine
npm run build:standalone -w @deadwick/voice
# copy packages/voice/dist/jarvis.standalone.js next to your page
```

```html
<div id="jarvis" style="position: fixed; inset: 0"></div>
<script type="module">
  import { createOrbScene } from './jarvis.standalone.js';
  const scene = createOrbScene(document.querySelector('#jarvis'));
  scene.setState('listening');   // idle | arming | listening | processing | speaking | error
</script>
```

`examples/embed.html` is this, complete and working. The bundle is ~900KB
(~200KB gzipped) because three.js is inlined; if your page already has a
bundler, import `@deadwick/orb-engine` instead and keep three.js external.

The container needs a size and a position. The canvas fills it.

### Level 2 — the orb speaks. Needs a server.

Add text-to-speech. The orb rides the real waveform.

```js
import { createSpeaker, createSceneSink, createDeepgramVoice } from './jarvis.standalone.js';

const speaker = createSpeaker({
  scene,
  sink: createSceneSink(scene),
  provider: createDeepgramVoice(),      // or createBrowserVoice() — free, no key
});

await speaker.speak('Good day, sir.');
```

`createDeepgramVoice` posts to `/api/tts/deepgram`, which **must** be served
by `server/speech-proxy.mjs`. The API key stays there.

`createBrowserVoice()` needs no server at all, but exposes no audio stream —
see the gotchas.

### Level 3 — full conversation. Needs a server.

Microphone in, Deepgram listens, a model thinks, Aura speaks, all on one
socket, with the orb following the agent's own events.

```js
import { createVoiceAgent, createSceneSink } from './jarvis.standalone.js';

const agent = createVoiceAgent({
  scene,
  sink: createSceneSink(scene),
  settings: JARVIS_AGENT_SETTINGS,      // copy apps/demo/src/agent-settings.ts
});

await agent.toggleMic();                // latch on; call again to switch off
agent.end();                            // close the socket
```

Requires both `server/speech-proxy.mjs` and `server/agent-relay.mjs`.

## 3. The server is not optional above Level 1

Levels 2 and 3 are **not** a static site. Something must run Node and hold
the API key, because a key in the browser is a key published to anyone who
opens the network tab.

In this repo that is a Vite plugin (`apps/demo/vite.config.ts`). Both server
files are plain Node with no build step, so mounting them in any server works
the same way:

```js
import { createTtsProxy } from './server/speech-proxy.mjs';
import { createAgentRelay } from './server/agent-relay.mjs';

app.use(createTtsProxy());                       // reads process.env

const relay = createAgentRelay();
httpServer.on('upgrade', (req, socket, head) => relay.handleUpgrade(req, socket, head));
```

Environment variables are in `.env.example`. They are deliberately **not**
`VITE_` prefixed — that naming is exactly what keeps them out of the client
bundle. Do not rename them.

## 4. What will bite you

Every one of these cost real debugging time. None are obvious from the code.

**three.js colour management.** Colours originate as sRGB hex but three keeps
them in a linear working space, so `setRGB(r, g, b)` without a colour space
reads them as linear and everything comes out far too bright — a near-black
background renders mid grey. Every colour goes through
`packages/orb-engine/src/scene/color.ts`.

**AdditiveBlending multiplies by source alpha.** Putting intensity in both the
colour and the alpha squares it. The glow shell rendered as literally nothing
until the magnitude moved entirely into the colour with alpha left at 1.

**Audio bands are in hertz, not bin fractions.** "The voice is bins 10%–60%"
sounds reasonable and is wrong: analyser bins span 0 to Nyquist, so on a
48kHz device that band is 2.4–14.4kHz, which is above almost all speech. The
orb tracked sibilance and silence. Bands are named in Hz and converted using
the analyser's real sample rate.

**Declare the microphone's real sample rate.** An AudioContext runs at 44100 on
plenty of hardware — including this project's own test machine. Telling the
agent 48000 while sending 44100 makes it hear a chipmunk and transcribe
nonsense. The engine reads `AudioContext.sampleRate` and sends that.

**`AgentAudioDone` is not the end of the agent's voice.** Deepgram documents it
as "the last chunk has been sent"; chunks already received are still in the
local queue. The orb leaves `speaking` when the playback queue drains.

**Browser speech synthesis has no audio stream.** The Web Speech API hands the
utterance straight to the OS synthesiser; nothing passes through Web Audio, so
there is nothing to analyse. With that provider the orb animates from its
synthetic envelope. Say so in the UI rather than implying otherwise.

**`/v1/auth/grant` needs Member permissions.** A Deepgram key that synthesises
speech perfectly can still be refused an agent token. That is why the agent
socket is relayed by default and mints no token at all.

**Node 22, and `npm ci` not `npm install`.** `.nvmrc` pins it. `npm install`
rewrites the lockfile as a side effect, which then blocks the next `git pull`.

**One WebGL context.** The engine owns one and draws three passes into it.
Browsers cap how many contexts a page may hold, so `destroy()` must be called
— it releases the context explicitly rather than waiting for garbage
collection.

## 5. Verifying a change

```bash
npm run check     # colour-token lint + typecheck + 181 unit tests
npm run build
./scripts/preview.sh restart --stubs
npm run shots     # screenshots the real scene and measures it
```

The unit tests cover the maths and run in Node in about two seconds. The
screenshot harness covers what they cannot: that the WebGL passes actually
draw, that transitions ease rather than snap, that stars stay square on any
window shape, that both audio paths carry signal, that teardown releases, and
that the whole conversation loop works.

`--stubs` runs stand-ins for Deepgram's speech and agent endpoints, so all of
that is exercised without an API key or a bill. `scripts/stub-tts.mjs` returns
real WAV; `scripts/stub-agent.mjs` talks the agent protocol.

One deliberate failure is worth knowing about: the `aspect-selftest` shot
breaks the star-field aspect correction on purpose and is *expected* to fail
the roundness check. A measure that cannot see the bug it guards against is
not a measure.
