/**
 * Screenshot the real scene in headless Chromium and measure what came back.
 *
 * Unit tests cover the maths; this covers the part the maths cannot: that the
 * WebGL passes actually draw, in the right order, in the right colours. Each
 * shot is written to shots/ and summarised numerically, so "the galaxy
 * brightens while it talks" is a number that can be compared, not a vibe.
 *
 *   npm run shots                       # every shot
 *   npm run shots -- --only speaking    # one
 *   npm run shots -- --url http://...   # against an already-running server
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import {
  decodePng,
  imageStats,
  meanAbsDiff,
  meanRgbOfRegion,
  pointAspectRatio,
} from './png.mjs';

const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium';
const OUT_DIR = join(process.cwd(), 'shots');
const VIEWPORT = { width: 1280, height: 800 };

/**
 * Software WebGL. The container has no GPU, so ANGLE is pointed at
 * SwiftShader; without --enable-unsafe-swiftshader recent Chromium refuses to
 * expose a context at all in headless.
 */
const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--hide-scrollbars',
  '--mute-audio',
  '--force-prefers-reduced-motion=0',
  // A synthetic microphone, auto-granted. Lets the real getUserMedia path be
  // exercised end to end — permission, stream, analyser tap, orb response —
  // rather than only the synthetic fallback.
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  // Clicking Speak is a gesture, so this is belt and braces — but without it
  // a suspended AudioContext makes the speech check fail for a reason that
  // has nothing to do with the code under test.
  '--autoplay-policy=no-user-gesture-required',
];

/**
 * Each shot: a page URL, an optional state to drive, and how long to let the
 * scene settle. State transitions ease over roughly a second, so anything
 * showing a state needs at least that.
 */
const SHOTS = [
  { name: 'idle', query: 'perf=high&motion=full', settle: 2200 },
  { name: 'arming', query: 'perf=high&motion=full', state: 'arming', settle: 2600 },
  { name: 'listening', query: 'perf=high&motion=full', state: 'listening', settle: 2600 },
  { name: 'processing', query: 'perf=high&motion=full', state: 'processing', settle: 3000 },
  { name: 'speaking', query: 'perf=high&motion=full', state: 'speaking', settle: 3000 },
  { name: 'error', query: 'perf=high&motion=full', state: 'error', settle: 2600 },
  { name: 'low-tier', query: 'perf=low&motion=full', state: 'speaking', settle: 2600 },
  // A deliberately tall window. The star grid is sampled in aspect-corrected
  // space, so the stars must stay round here rather than stretching into
  // vertical dashes.
  {
    name: 'portrait',
    query: 'perf=high&motion=full&ui=off',
    state: 'processing',
    settle: 2600,
    viewport: { width: 480, height: 900 },
    expectStarAspect: 'round',
  },
  // The same tall window with the aspect correction deliberately disabled.
  // This shot is expected to FAIL roundness: it is how the check above earns
  // its keep. A measure that cannot see this is not measuring anything.
  // Drives the real microphone path: clicks the mic control, which asks for
  // permission, attaches the stream and arms the orb. The fake device plays a
  // tone, so a working tap shows up as a non-zero voice level.
  {
    name: 'mic',
    query: 'perf=high&motion=full&audio=off',
    click: '#mic-button',
    settle: 3000,
    expectState: 'listening',
    expectLevelAbove: 0.05,
  },
  // Drives the real playback path: a synthesised utterance through WebAudio,
  // tapped without altering what is heard.
  {
    name: 'tone',
    query: 'perf=high&motion=full&audio=off',
    click: '#tone-button',
    settle: 3000,
    expectState: 'speaking',
    expectLevelAbove: 0.05,
  },
  {
    name: 'landscape-stars',
    query: 'perf=high&motion=full&ui=off&audio=off',
    settle: 2000,
    expectStarAspect: 'round',
  },
  {
    name: 'aspect-selftest',
    query: 'perf=high&motion=full&ui=off',
    settle: 1200,
    viewport: { width: 480, height: 900 },
    debugBreakAspect: true,
    expectStarAspect: 'stretched',
  },
];

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const baseUrl = argValue('--url', 'http://127.0.0.1:4173');
const only = argValue('--only', null);
// --checks-only runs the lifecycle, reduced-motion and live-region checks
// without re-shooting every state, which makes those fast to iterate on.
const checksOnly = args.includes('--checks-only');
const shots = checksOnly ? [] : only ? SHOTS.filter((s) => s.name === only) : SHOTS;
if (shots.length === 0 && !checksOnly) {
  console.error(`no shot named ${only}. Known: ${SHOTS.map((s) => s.name).join(', ')}`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, args: CHROME_ARGS });
const results = [];
let problems = 0;

for (const shot of shots) {
  const page = await browser.newPage({ viewport: shot.viewport ?? VIEWPORT, deviceScaleFactor: 1 });
  const messages = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') messages.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => messages.push(`pageerror: ${e.message}`));

  const url = `${baseUrl}/?${shot.query}`;
  await page.goto(url, { waitUntil: 'load' });

  // Fail fast and loudly if WebGL is unavailable, rather than filing a black
  // screenshot as a passing result.
  const gl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!context) return null;
    const info = context.getExtension('WEBGL_debug_renderer_info');
    return info ? String(context.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown renderer';
  });
  if (!gl) {
    console.error('✗ no WebGL context available in this browser');
    process.exit(1);
  }

  await page.waitForFunction(() => Boolean(window.scene), null, { timeout: 10_000 });
  if (shot.debugBreakAspect) await page.evaluate(() => window.scene.debugForceSquareAspect(true));
  // Click the real control rather than calling the API: that exercises the
  // path a user takes, including the chip and readout wiring. Shots that hide
  // the chrome have no control to click, so those drive the handle directly.
  if (shot.state) {
    if (shot.query.includes('ui=off')) {
      await page.evaluate((s) => window.scene.setState(s), shot.state);
    } else {
      await page.click(`button[data-state="${shot.state}"]`);
    }
  }
  if (shot.click) await page.click(shot.click);
  await page.waitForTimeout(shot.settle);

  // A single instantaneous read of the voice level is a flaky thing to assert
  // on: Chromium's fake capture device beeps intermittently rather than
  // holding a tone, so one sample can legitimately land in a gap. Shots that
  // make a claim about audio watch for a peak over a window instead.
  let peakLevel = 0;
  if (shot.expectLevelAbove !== undefined) {
    for (let i = 0; i < 24; i += 1) {
      const level = await page.evaluate(() => window.scene.getAudioLevels().level);
      peakLevel = Math.max(peakLevel, level);
      if (peakLevel > shot.expectLevelAbove) break;
      await page.waitForTimeout(120);
    }
  }

  const probe = await page.evaluate(() => ({
    state: window.scene.getState(),
    tier: window.scene.getPerformanceTier(),
    fps: Math.round(window.scene.getFps()),
    audio: window.scene.getAudioLevels(),
  }));
  probe.peakLevel = Math.max(peakLevel, probe.audio.level);

  const file = join(OUT_DIR, `${shot.name}.png`);
  const buffer = await page.screenshot({ type: 'png' });
  writeFileSync(file, buffer);
  const decoded = decodePng(buffer);
  const stats = imageStats(decoded);
  const starAspect = pointAspectRatio(decoded);

  // Take a second frame a beat later and diff it. A still scene and a moving
  // one look identical in a single screenshot; this is what distinguishes
  // "breathing gently" from "stopped".
  await page.waitForTimeout(900);
  const motion = meanAbsDiff(decodePng(buffer), decodePng(await page.screenshot({ type: 'png' })));

  if (messages.length > 0) problems += messages.length;
  results.push({ shot: shot.name, gl, probe, stats, motion, starAspect, messages });
  await page.close();
}

// --- transition check --------------------------------------------------------
// "Nothing snaps" is a claim about the frames between two states, which a
// screenshot of either endpoint cannot show.
//
// A straight pixel diff cannot answer it either: the sky twinkles and the
// mesh morphs continuously, and that noise saturates an absolute difference,
// so an eased transition scores the same as a hard cut. Averaging the whole
// frame to its mean RGB cancels the twinkle, and projecting the mid-flight
// colour onto the line from the start colour to the settled one says how far
// along the journey the scene actually was.
//
// The voice is switched off for this check (?audio=off). The envelope
// follower is deliberately fast-attack, so entering a state that routes audio
// lights the scene up quickly by design — that is the voice arriving, not the
// state snapping, and leaving it on measures the two mixed together. What is
// under test here is the state easing alone.
const TRANSITION_SAMPLE_MS = 120;
/**
 * The transition pages render small and cheap.
 *
 * Only the mean colour of the frame is read, so resolution buys nothing — and
 * at full size this container manages about four frames a second under
 * software rendering, which makes a 300ms sample land wherever a frame
 * happens to fall rather than where it was asked for. A small viewport at the
 * low tier gives enough frames for the sample to mean something.
 */
const TRANSITION_VIEWPORT = { width: 400, height: 260 };
const transitions = [];

// The central half of the frame: the orb and its halo, where a state change
// actually shows. A whole-frame mean is mostly sky, and for a pair of states
// whose skies differ little that leaves almost no signal to measure.
const meanRgbOf = (buffer) => meanRgbOfRegion(decodePng(buffer), 0.5);
const progressAlong = (before, mid, after) => {
  const d = after.map((v, i) => v - before[i]);
  const m = mid.map((v, i) => v - before[i]);
  const denominator = d.reduce((sum, v) => sum + v * v, 0);
  if (denominator < 1e-9) return 0;
  return d.reduce((sum, v, i) => sum + v * m[i], 0) / denominator;
};

if (!only || checksOnly) {
  for (const [from, to] of [
    ['idle', 'speaking'],
    ['idle', 'error'],
    ['listening', 'processing'],
  ]) {
    const page = await browser.newPage({
      viewport: TRANSITION_VIEWPORT,
      deviceScaleFactor: 1,
    });
    await page.goto(`${baseUrl}/?perf=low&motion=full&audio=off&ui=off`, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean(window.scene), null, { timeout: 10_000 });

    await page.evaluate((s) => window.scene.setState(s), from);
    await page.waitForTimeout(2400);
    const before = meanRgbOf(await page.screenshot({ type: 'png' }));

    const clockAtClick = await page.evaluate((s) => {
      window.scene.setState(s);
      return window.scene.debugClocks().animTime;
    }, to);
    await page.waitForTimeout(TRANSITION_SAMPLE_MS);
    const mid = meanRgbOf(await page.screenshot({ type: 'png' }));
    const animElapsed = (await page.evaluate(() => window.scene.debugClocks().animTime)) -
      clockAtClick;

    await page.waitForTimeout(2400);
    const after = meanRgbOf(await page.screenshot({ type: 'png' }));

    transitions.push({ from, to, progress: progressAlong(before, mid, after), animElapsed });
    await page.close();
  }
}

// --- lifecycle check ---------------------------------------------------------
// Destroy and recreate the scene many times over. A browser allows only
// around sixteen live WebGL contexts, so a teardown that leaks one per cycle
// shows up here as the browser quietly dropping older contexts and the scene
// going blank — not as an exception anyone would otherwise see.
const RECREATE_CYCLES = 24;
let lifecycle = null;

if (!only || checksOnly) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const noise = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') noise.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => noise.push(`pageerror: ${e.message}`));

  await page.goto(`${baseUrl}/?perf=high&motion=full&ui=off&audio=off`, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.scene), null, { timeout: 10_000 });

  for (let i = 0; i < RECREATE_CYCLES; i += 1) {
    await page.evaluate(() => window.recreateScene());
    await page.waitForTimeout(60);
  }

  // The scene that survives all that still has to render and still has to move.
  await page.waitForTimeout(1500);
  const first = decodePng(await page.screenshot({ type: 'png' }));
  await page.waitForTimeout(800);
  const second = decodePng(await page.screenshot({ type: 'png' }));

  const canvases = await page.evaluate(() => document.querySelectorAll('canvas').length);
  const liveRegions = await page.evaluate(
    () => document.querySelectorAll('.orb-live-region').length,
  );

  lifecycle = {
    cycles: RECREATE_CYCLES,
    stdDev: imageStats(first).stdDev,
    motion: meanAbsDiff(first, second),
    canvases,
    liveRegions,
    noise,
  };
  await page.close();
}

// --- reduced motion ----------------------------------------------------------
// The OS setting is honoured by slowing the engine's own animation clock
// rather than by multiplying wall time, so the clock is what to measure.
//
// Inferring it from pixels does not work: an absolute frame-to-frame
// difference saturates once the starfield has decorrelated from its earlier
// self, and both clocks pass that point quickly, which made a threefold
// slowdown read as a small one. Reading the clock is exact. A pixel check
// still runs alongside it, for the opposite failure — honouring the setting
// by stopping the scene dead instead of calming it.
let reducedMotion = null;

if (!only || checksOnly) {
  const measure = async (opts) => {
    const page = await browser.newPage({ ...opts, viewport: VIEWPORT, deviceScaleFactor: 1 });
    await page.goto(`${baseUrl}/?perf=high&ui=off&audio=off`, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean(window.scene), null, { timeout: 10_000 });
    await page.waitForTimeout(800);

    // Clock first, over a clean window. A screenshot of a software-rendered
    // WebGL canvas takes long enough to stall the frame loop, so sampling the
    // clock across one measures the screenshot as much as the animation.
    const start = await page.evaluate(() => ({
      anim: window.scene.debugClocks().animTime,
      wall: performance.now(),
    }));
    await page.waitForTimeout(2000);
    const end = await page.evaluate(() => ({
      anim: window.scene.debugClocks().animTime,
      wall: performance.now(),
      scale: window.scene.debugClocks().motionScale,
    }));

    // Pixels afterwards, purely to catch a scene that has stopped dead.
    const beforePixels = decodePng(await page.screenshot({ type: 'png' }));
    await page.waitForTimeout(1200);
    const afterPixels = decodePng(await page.screenshot({ type: 'png' }));

    await page.close();
    return {
      // Animation seconds elapsed per real second.
      rate: (end.anim - start.anim) / ((end.wall - start.wall) / 1000),
      scale: end.scale,
      motion: meanAbsDiff(beforePixels, afterPixels),
    };
  };

  const full = await measure({ reducedMotion: 'no-preference' });
  const reduced = await measure({ reducedMotion: 'reduce' });
  reducedMotion = { full, reduced, ratio: full.rate > 0 ? reduced.rate / full.rate : 1 };
}

// --- speech ------------------------------------------------------------------
// Drives the whole voice chain the way a person does: pick a voice, type,
// press Speak. With ./scripts/preview.sh --stub-tts the upstream is a local
// stand-in for Deepgram that returns a real WAV, so every link is exercised
// except Deepgram's own servers — the one link an API key would test and
// nothing else would.
let speech = null;

if (!only || checksOnly) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const noise = [];
  page.on('console', (m) => {
    if (m.type() === 'error') noise.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => noise.push(`pageerror: ${e.message}`));

  await page.goto(`${baseUrl}/?perf=high&motion=full&audio=off`, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.speaker), null, { timeout: 10_000 });

  const health = await page.evaluate(async () => {
    const response = await fetch('/api/tts/health');
    return response.ok ? await response.json() : null;
  });
  const deepgramReady = Boolean(health?.providers?.deepgram?.configured);

  if (!deepgramReady) {
    speech = { skipped: 'no speech proxy configured — run ./scripts/preview.sh --stub-tts' };
  } else {
    // Wait for the provider probe to finish populating the control.
    await page.waitForFunction(
      () => {
        const select = document.querySelector('#voice-select');
        return Boolean(select?.querySelector('option[value="deepgram"]:not([disabled])'));
      },
      null,
      { timeout: 10_000 },
    );
    await page.selectOption('#voice-select', 'deepgram');
    await page.fill('#say-text', 'Good day, sir. Jarvis Wick online. What do you need?');

    const seen = new Set();
    const sample = async () => {
      const probe = await page.evaluate(() => ({
        state: window.scene.getState(),
        level: window.scene.getAudioLevels().level,
      }));
      seen.add(probe.state);
      return probe;
    };

    await page.click('#say-button');

    let peakLevel = 0;
    let speakingSamples = 0;
    let shot = null;
    for (let i = 0; i < 90; i += 1) {
      const probe = await sample();
      peakLevel = Math.max(peakLevel, probe.level);
      if (probe.state === 'speaking') {
        speakingSamples += 1;
        // Screenshot a little way in, once the envelope has risen, rather
        // than on the very first speaking frame where it is still near zero.
        if (!shot && speakingSamples > 3) shot = await page.screenshot({ type: 'png' });
      }
      if (seen.has('speaking') && probe.state === 'idle') break;
      await page.waitForTimeout(80);
    }

    if (shot) writeFileSync(join(OUT_DIR, 'speaking-deepgram.png'), shot);
    speech = {
      states: [...seen],
      peakLevel,
      speakingSamples,
      returnedToIdle: (await sample()).state === 'idle',
      noise,
    };
  }
  await page.close();
}

// --- live region -------------------------------------------------------------
// A screen reader needs to be told whether this thing is listening or
// thinking. Check the region exists, is polite, and actually tracks the state.
let liveRegion = null;

if (!only || checksOnly) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  await page.goto(`${baseUrl}/?perf=high&motion=full&audio=off`, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.scene), null, { timeout: 10_000 });

  const announcements = [];
  for (const state of ['listening', 'processing', 'error', 'idle']) {
    await page.click(`button[data-state="${state}"]`);
    await page.waitForTimeout(120);
    announcements.push({
      state,
      text: await page.evaluate(() => {
        const el = document.querySelector('[role="status"]');
        return el ? (el.textContent ?? '').trim() : null;
      }),
      polite: await page.evaluate(
        () => document.querySelector('[role="status"]')?.getAttribute('aria-live') ?? null,
      ),
    });
  }
  liveRegion = announcements;
  await page.close();
}

await browser.close();

const f = (v, n = 3) => v.toFixed(n);
console.log(`\nrenderer: ${results[0]?.gl ?? 'n/a'}`);
console.log('(peak = highest voice level seen while the shot settled)\n');
console.log(
  ['shot', 'state', 'tier', 'fps', 'mean', 'stddev', 'max', 'lit', 'r', 'g', 'b', 'peak', 'motion']
    .map((h) => h.padEnd(h === 'shot' ? 11 : 8))
    .join(''),
);
for (const r of results) {
  console.log(
    [
      r.shot.padEnd(11),
      r.probe.state.padEnd(8),
      r.probe.tier.padEnd(8),
      String(r.probe.fps).padEnd(8),
      f(r.stats.mean).padEnd(8),
      f(r.stats.stdDev).padEnd(8),
      f(r.stats.max).padEnd(8),
      f(r.stats.litFraction).padEnd(8),
      f(r.stats.meanRgb[0]).padEnd(8),
      f(r.stats.meanRgb[1]).padEnd(8),
      f(r.stats.meanRgb[2]).padEnd(8),
      f(r.probe.peakLevel, 2).padEnd(8),
      f(r.motion, 4),
    ].join(''),
  );
}

console.log('\nstar roundness (width:height of bright points; 1.0 means square pixels):');
for (const r of results) {
  console.log(
    `  ${r.shot.padEnd(11)} ${r.starAspect === null ? 'too few points' : f(r.starAspect, 2)}`,
  );
}
const isStretched = (r) => r.starAspect !== null && Math.abs(r.starAspect - 1) > 0.25;
for (const r of results) {
  // Only shots that declare an expectation are enforced. The rest still
  // report a number, but their UI chrome makes it advisory: bright glyphs are
  // elongated blobs and bias the median.
  const expected = SHOTS.find((s) => s.name === r.shot)?.expectStarAspect;
  if (!expected) continue;
  if (expected === 'stretched') {
    if (!isStretched(r)) {
      console.error(
        `\n✗ ${r.shot}: the roundness check failed to notice a deliberately broken aspect ` +
          `(measured ${r.starAspect === null ? 'nothing' : f(r.starAspect, 2)}). ` +
          'The check is not measuring what it claims to.',
      );
      problems += 1;
    }
  } else if (expected === 'round' && isStretched(r)) {
    console.error(`\n✗ ${r.shot}: stars are stretched (${f(r.starAspect, 2)})`);
    problems += 1;
  }
}

console.log('\ncentre-weighted 3x3 luminance grid (top row first):');
for (const r of results) {
  const g = r.stats.grid.map((v) => f(v));
  console.log(`  ${r.shot.padEnd(11)} [${g.slice(0, 3)}] [${g.slice(3, 6)}] [${g.slice(6, 9)}]`);
}

const frozen = results.filter((r) => r.probe.state !== 'error' && r.motion < 0.0004);
if (frozen.length > 0) {
  console.error(
    `\n✗ ${frozen.length} shot(s) are not animating: ${frozen.map((r) => r.shot).join(', ')}`,
  );
  problems += frozen.length;
}

const quiet = results.filter((r) => r.stats.stdDev < 0.004);
if (quiet.length > 0) {
  console.error(
    `\n✗ ${quiet.length} shot(s) look blank (stddev < 0.004): ${quiet.map((r) => r.shot).join(', ')}`,
  );
  problems += quiet.length;
}
// Per-shot expectations: a shot that drives a real audio path has to show
// that the path actually carried something.
for (const r of results) {
  const spec = SHOTS.find((s) => s.name === r.shot);
  if (spec?.expectState && r.probe.state !== spec.expectState) {
    console.error(
      `\n✗ ${r.shot}: expected state ${spec.expectState}, got ${r.probe.state}`,
    );
    problems += 1;
  }
  if (spec?.expectLevelAbove !== undefined && !(r.probe.peakLevel > spec.expectLevelAbove)) {
    console.error(
      `\n✗ ${r.shot}: voice level peaked at ${f(r.probe.peakLevel, 3)} over the sampling ` +
        `window and never exceeded ${spec.expectLevelAbove} — the audio tap carried nothing`,
    );
    problems += 1;
  }
}

for (const r of results) {
  for (const m of r.messages) console.error(`\n✗ ${r.shot}: ${m}`);
}

if (transitions.length > 0) {
  // Reading the progress figure alone is not enough: how far along a
  // transition should be depends on how much animation time actually passed,
  // and under software rendering that varies run to run. So invert the easing
  // instead. For an exponential approach, progress p over t seconds implies a
  // rate of -ln(1 - p) / t, which is comparable no matter when the sample
  // landed.
  //
  // The engine eases colour at about 2.8/s and the other parameters at about
  // 3.7/s, and the sampled colour moves under both. A hard cut would imply an
  // enormous rate; a scene that ignored the click, a rate near zero.
  //
  // The accepted floor sits well below the parameter rates on purpose. Not
  // every visual difference between two states is an eased parameter: the
  // mesh also has to morph there, and that follows the noise clock, which
  // accumulates at the state's noise speed rather than chasing a target. For
  // a pair like idle and error, where the noise speed itself drops to almost
  // nothing, a real part of the change settles slowly and drags the implied
  // rate down. The upper bound is what guards against snapping; the lower one
  // only has to catch a click that did nothing at all.
  const RATE_BAND = { min: 0.8, max: 8 };
  console.log('\nstate transitions (easing rate implied by the rendered frames):');
  for (const t of transitions) {
    const implied = t.animElapsed > 0 ? -Math.log(1 - Math.min(0.999, t.progress)) / t.animElapsed : 0;
    t.impliedRate = implied;
    console.log(
      `  ${`${t.from} -> ${t.to}`.padEnd(24)} progress ${f(t.progress, 3)} after ` +
        `${f(t.animElapsed, 3)}s  =>  ${f(implied, 2)}/s`,
    );
  }
  console.log(`  (engine eases at 2.8-3.7/s; accepted band ${RATE_BAND.min}-${RATE_BAND.max}/s)`);

  const snapped = transitions.filter((t) => t.impliedRate > RATE_BAND.max);
  const stalled = transitions.filter((t) => t.impliedRate < RATE_BAND.min);
  if (snapped.length > 0) {
    console.error(
      `\n✗ ${snapped.length} transition(s) snap rather than ease: ` +
        snapped.map((t) => `${t.from}->${t.to} (${f(t.impliedRate, 1)}/s)`).join(', '),
    );
    problems += snapped.length;
  }
  if (stalled.length > 0) {
    console.error(
      `\n✗ ${stalled.length} transition(s) barely moved: ` +
        stalled.map((t) => `${t.from}->${t.to} (${f(t.impliedRate, 1)}/s)`).join(', '),
    );
    problems += stalled.length;
  }
}

if (lifecycle) {
  console.log(`\nlifecycle: ${lifecycle.cycles} destroy/recreate cycles`);
  console.log(
    `  surviving canvases ${lifecycle.canvases}  live regions ${lifecycle.liveRegions}  ` +
      `content ${f(lifecycle.stdDev)}  motion ${f(lifecycle.motion, 4)}`,
  );
  if (lifecycle.canvases !== 1 || lifecycle.liveRegions !== 1) {
    console.error(
      `\n✗ teardown leaks DOM: ${lifecycle.canvases} canvas(es) and ` +
        `${lifecycle.liveRegions} live region(s) remain, expected 1 of each`,
    );
    problems += 1;
  }
  if (lifecycle.stdDev < 0.01) {
    console.error('\n✗ the scene is blank after repeated recreation — a context was lost');
    problems += 1;
  }
  if (lifecycle.motion < 0.0004) {
    console.error('\n✗ the scene stopped animating after repeated recreation');
    problems += 1;
  }
  for (const n of lifecycle.noise) {
    console.error(`\n✗ lifecycle: ${n}`);
    problems += 1;
  }
}

if (reducedMotion) {
  const { full, reduced, ratio } = reducedMotion;
  console.log('\nreduced motion (animation seconds per real second):');
  console.log(
    `  full    rate ${f(full.rate, 3)}  scale ${f(full.scale, 2)}  pixels ${f(full.motion, 4)}`,
  );
  console.log(
    `  reduced rate ${f(reduced.rate, 3)}  scale ${f(reduced.scale, 2)}  ` +
      `pixels ${f(reduced.motion, 4)}`,
  );
  console.log(`  clock ratio ${f(ratio, 3)}`);

  if (!(ratio < 0.5)) {
    console.error(`\n✗ reduce-motion barely slows the clock (ratio ${f(ratio, 2)})`);
    problems += 1;
  }
  // Not 1.0: under software rendering this container manages only a few
  // frames a second, and below four the integration cap deliberately slows
  // the clock rather than letting the scene jump. On real hardware frames are
  // milliseconds and the cap never applies.
  if (!(full.rate > 0.5)) {
    console.error(
      `\n✗ the clock runs far behind real time (${f(full.rate, 2)}x) even at full motion`,
    );
    problems += 1;
  }
  // Calmer, not frozen: a still scene is its own accessibility failure.
  if (reduced.motion < 0.0004) {
    console.error('\n✗ reduce-motion stops the scene entirely rather than slowing it');
    problems += 1;
  }
}

if (liveRegion) {
  console.log('\nlive region:');
  for (const a of liveRegion) {
    console.log(`  ${a.state.padEnd(12)} aria-live=${a.polite}  "${a.text}"`);
  }
  for (const a of liveRegion) {
    if (a.polite !== 'polite') {
      console.error(`\n✗ live region is not polite for ${a.state} (got ${a.polite})`);
      problems += 1;
    }
    if (!a.text) {
      console.error(`\n✗ live region says nothing for ${a.state}`);
      problems += 1;
    }
  }
  const texts = liveRegion.map((a) => a.text);
  if (new Set(texts).size !== texts.length) {
    console.error(`\n✗ live region does not distinguish the states: ${texts.join(' / ')}`);
    problems += 1;
  }
}

if (speech) {
  if (speech.skipped) {
    console.log(`\nspeech: skipped — ${speech.skipped}`);
  } else {
    console.log('\nspeech (Deepgram path, driven through the real controls):');
    console.log(
      `  states seen ${speech.states.join(' -> ')}  peak voice level ${f(speech.peakLevel, 3)}` +
        `  (${speech.speakingSamples} samples while speaking)`,
    );

    // The orb has to pass through thinking on its way to speaking: that phase
    // is the network round trip and decode, and skipping it would mean the
    // state is being guessed rather than driven by the audio.
    for (const required of ['processing', 'speaking']) {
      if (!speech.states.includes(required)) {
        console.error(`\n✗ speech: the orb never entered '${required}' (saw ${speech.states.join(', ')})`);
        problems += 1;
      }
    }
    if (!(speech.peakLevel > 0.05)) {
      console.error(
        `\n✗ speech: voice level peaked at ${f(speech.peakLevel, 3)} — the orb is not riding the audio`,
      );
      problems += 1;
    }
    if (!speech.returnedToIdle) {
      console.error('\n✗ speech: the orb did not return to idle when the audio finished');
      problems += 1;
    }
    for (const n of speech.noise) {
      console.error(`\n✗ speech: ${n}`);
      problems += 1;
    }
  }
}

console.log(`\nwrote ${results.length} shot(s) to shots/`);
if (problems > 0) {
  console.error(`✗ ${problems} problem(s)`);
  process.exit(1);
}
console.log('✓ no console errors, every shot has content');
