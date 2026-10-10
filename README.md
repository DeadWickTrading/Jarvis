# Jarvis — a living galaxy

A full-screen scene that gives an AI a face: a wireframe orb floating in a
deep-space nebula, surrounded by a slowly turning network of glowing star
clusters joined by faint lines. The orb changes colour and motion with what
the AI is doing, rides the waveform of real audio, and the whole galaxy
brightens and swells while it talks.

Quiet until it matters. At rest it should look like a mind idling in deep
space. If it ever looks busy when nothing is happening, turn it down.

```
packages/orb-engine    the engine: framework-free TypeScript, three.js, no backend
apps/demo              a Vite page that embeds it, with a control for every state
scripts/               token generation, the screenshot harness, a PNG reader
```

## Quick start

```bash
npm install
npm run dev          # http://127.0.0.1:5173
```

Then click through the states, hold down the microphone, or press the test
tone. Keys `1`–`6` switch state, `M` toggles the mic, `T` plays the tone.

```bash
npm run check        # tokens lint + typecheck + unit tests
npm run build        # engine bundle and demo site
npm run shots        # screenshot the real scene and measure it (see below)
```

## Using the engine

The engine never talks to a backend. It takes a state and, optionally,
something to listen to.

```ts
import { createOrbScene } from '@deadwick/orb-engine';

const scene = createOrbScene(document.querySelector('#scene')!, {
  initialState: 'idle',
});

scene.setState('listening');
scene.setMicSource(micStream);          // a MediaStream, AudioNode or media element
scene.setPlaybackSource(ttsAudioElement);
scene.setPerformanceMode('auto');       // 'auto' | 'high' | 'low'

scene.destroy();                        // releases the WebGL context
```

Audio is tapped, never rerouted. A `MediaStream` or `AudioNode` is a pure
fan-out. An `HTMLMediaElement` is the one case needing care, because
`createMediaElementSource` moves the element's output off the default device
and into the graph; the engine immediately reconnects it to the destination,
so playback is unchanged.

An `AudioNode` you build yourself must belong to the engine's context, which
`scene.getAudioContext()` returns. Web Audio refuses to connect nodes across
contexts, and says so in a message that names neither of them.

## The six states

| State | Look | Audio |
|---|---|---|
| `idle` | Dim lime, slow breathing, faint halo | — |
| `arming` | Dim ember | — |
| `listening` | Bright amber, high amplitude, strong glow | microphone |
| `processing` | Lime flowing to violet, rings visible, faster rotation | — |
| `speaking` | Bright lime, the whole galaxy lights up | playback |
| `error` | Red, still, sharp edge | — |

`arming` earns its own state. It means the microphone has been asked for and
nothing has arrived yet, and showing that honestly is the difference between
a user reading "still waiting for permission" and reading a bright recording
light that is recording nothing.

Only `speaking` and `processing` drive the network and sky. **The galaxy
answers the AI, not the user**: shouting at the microphone moves the orb and
leaves the constellation alone.

## How it is put together

**One renderer, one WebGL context, three passes per frame.** The sky is a
full-screen shader drawn first with depth testing off. The star network
follows, with its own perspective camera that drifts slowly. Then the depth
buffer is cleared and the orb is drawn on top with its own camera. Stacking
two canvases would be more expensive and invites compositing glitches.

**three.js is pinned and bundled from npm.** Nothing is fetched at runtime,
including the fonts, so the page works offline.

**The maths is pure and tested; the three.js code only draws numbers.** The
state table, the easing, the audio bands, the synthetic envelope, the seeded
layout and the performance decision are each small modules with unit tests
and no WebGL in them. 105 tests run in about two seconds, in Node, with no
browser.

**All state lives in one table.** `states.ts` holds every visual parameter for
every state in one object. Each frame every parameter moves part of the way
toward the current state's target. Nothing snaps.

**Easing is frame-rate independent.** Parameters ease by integrating a decay
rate over elapsed time, so sixty steps of 1/60s, thirty of 2/60s and a single
one-second step all land in the same place. A test asserts exactly that, and
the screenshot harness measures it in the browser as well.

**The layout is seeded.** The same seed always builds the same galaxy, so a
visual difference between runs means the code changed rather than the dice.
Nodes are emitted round-robin across the clusters, which is what lets the
cheaper tier take a prefix and get the same galaxy with fewer points instead
of a galaxy missing one side of the sky.

## Colour and type

`packages/orb-engine/src/brand.ts` is the single source of every colour in
the system. The demo's CSS custom properties and its favicon are generated
from it:

```bash
npm run tokens       # regenerate
npm run lint:tokens  # fail if they drift, or if a colour literal appears anywhere else
```

The lint is not decorative — it caught a hex sitting in a doc comment during
development.

Type is self-hosted: Unbounded for the wordmark, Bricolage Grotesque for body
text, IBM Plex Mono for labels and numbers, with Menlo behind it. The woff2
files live in the repo, so nothing is requested from a font CDN at runtime.

**Dark only**, as specified. The scene is built around a near-black field and
additive blending, and light mode is deliberately out of scope. The generated
token file is the one place a light set would go; the engine would also need
normal rather than additive blending for its particles and glow, which is
noted where that blending is set up.

## Performance

The engine measures its own frame rate. If it stays under 45fps for three
sustained seconds it drops to the cheaper tier: pixel ratio 1, a coarser orb,
fewer nodes and dust, and a three-octave nebula instead of five.

The drop latches. A scene that downgrades becomes cheaper, which raises the
frame rate, which would immediately argue for upgrading again — a loop that
visibly oscillates. Once it goes low it stays low. `setPerformanceMode()`
overrides the decision in either direction.

One good frame is not recovery, either: the accumulated debt decays rather
than resetting, so a scene alternating between 25 and 60fps still trips. That
behaviour has a test.

The watchdog sees real elapsed time, while the animation clock integrates a
capped value so that a tab returning from the background does not jump the
scene forward. Those have to be separate numbers: feeding the capped value to
the watchdog floors the reported frame rate at `1 / cap`, which is how a page
genuinely managing three frames a second reported twelve for most of this
project's development. Gaps of more than half a second are ignored outright —
a backgrounded tab is a stall, not a frame rate.

## Accessibility

Reduced motion is honoured by slowing the engine's **own animation clock**,
not by multiplying wall time. The clock keeps accumulating from wherever it
had reached; scaling elapsed time instead would teleport every sine in every
shader the instant the setting changed.

An ARIA live region inside the scene container names the current state, so
someone using a screen reader knows whether this thing is listening or
thinking.

## Verifying it

Unit tests cover the maths. They cannot cover whether the WebGL passes
actually draw, in the right order, in the right colours — so `npm run shots`
drives the real page in headless Chromium, writes a screenshot per state, and
measures what came back: brightness, colour balance, a 3×3 luminance grid, a
frame-to-frame diff that tells a breathing scene from a stopped one, and more.

It also checks the things a still screenshot cannot show:

- **Transitions ease rather than snap.** The mid-flight mean colour is
  projected onto the line between the two states, and the easing is then
  inverted to recover the rate it implies, which is comparable however much
  animation time happened to pass before the sample landed.
- **Stars stay square** on any window shape. One shot deliberately breaks the
  aspect correction and is *expected to fail* the roundness check: a measure
  that cannot see the bug it guards against is not a measure.
- **The audio paths carry something.** Chromium's fake capture device plays a
  tone through the real `getUserMedia` path; the shot asserts the voice level
  rose, so a silently broken tap fails instead of producing a pretty picture.
- **Teardown really releases.** The scene is destroyed and recreated two dozen
  times; a leak would exhaust the browser's WebGL context limit and the final
  scene would be blank.
- **Reduce-motion slows without freezing.** Measured by reading the engine's
  clock, not by diffing pixels: an absolute frame difference saturates once
  the starfield has decorrelated, and that made a threefold slowdown look
  like a small one.
- **The live region tracks the state.**

Every one of these exists because something was wrong and a screenshot was
the only thing that said so.

## A deliberate departure

The brief specified the audio bands as fractions of the analyser's bin array:
the voice as "bins 10% to 60%". On a Web Audio analyser the bins span zero to
the Nyquist frequency, so at the usual 48kHz sample rate that band is 2.4kHz
to 14.4kHz. Human speech energy is almost entirely below 3.5kHz. The orb would
have tracked sibilance and room hiss — responding to "s" sounds while sitting
still through a vowel.

The bands are therefore named in hertz (voice 180–3600, bass 40–180, treble
3600–9000) and converted using the analyser's real sample rate, so they stay
right across devices. The FFT is 2048 points rather than 512, because 94Hz
bins cannot separate bass from voice at all. At that resolution the bass band
works out as the first six bins, which is what the brief asked for.

The reasoning is repeated in a comment beside the defaults in
`packages/orb-engine/src/audio/levels.ts`.
