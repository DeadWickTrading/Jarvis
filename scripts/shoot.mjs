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
import { decodePng, imageStats, meanAbsDiff, pointAspectRatio } from './png.mjs';

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
const shots = only ? SHOTS.filter((s) => s.name === only) : SHOTS;
if (shots.length === 0) {
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
  // path a user takes, including the chip and readout wiring.
  if (shot.state) await page.click(`button[data-state="${shot.state}"]`);
  if (shot.click) await page.click(shot.click);
  await page.waitForTimeout(shot.settle);

  const probe = await page.evaluate(() => ({
    state: window.scene.getState(),
    tier: window.scene.getPerformanceTier(),
    fps: Math.round(window.scene.getFps()),
    audio: window.scene.getAudioLevels(),
  }));

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
const TRANSITION_SAMPLE_MS = 150;
const transitions = [];

const meanRgbOf = (buffer) => imageStats(decodePng(buffer)).meanRgb;
const progressAlong = (before, mid, after) => {
  const d = after.map((v, i) => v - before[i]);
  const m = mid.map((v, i) => v - before[i]);
  const denominator = d.reduce((sum, v) => sum + v * v, 0);
  if (denominator < 1e-9) return 0;
  return d.reduce((sum, v, i) => sum + v * m[i], 0) / denominator;
};

if (!only) {
  for (const [from, to] of [
    ['idle', 'speaking'],
    ['idle', 'error'],
    ['listening', 'processing'],
  ]) {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    await page.goto(`${baseUrl}/?perf=high&motion=full&audio=off`, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean(window.scene), null, { timeout: 10_000 });

    await page.click(`button[data-state="${from}"]`);
    await page.waitForTimeout(2400);
    const before = meanRgbOf(await page.screenshot({ type: 'png' }));

    await page.click(`button[data-state="${to}"]`);
    await page.waitForTimeout(TRANSITION_SAMPLE_MS);
    const mid = meanRgbOf(await page.screenshot({ type: 'png' }));

    await page.waitForTimeout(2400);
    const after = meanRgbOf(await page.screenshot({ type: 'png' }));

    transitions.push({ from, to, progress: progressAlong(before, mid, after) });
    await page.close();
  }
}

await browser.close();

const f = (v, n = 3) => v.toFixed(n);
console.log(`\nrenderer: ${results[0]?.gl ?? 'n/a'}\n`);
console.log(
  ['shot', 'state', 'tier', 'fps', 'mean', 'stddev', 'max', 'lit', 'r', 'g', 'b', 'lvl']
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
      f(r.probe.audio.level, 2).padEnd(8),
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
  if (spec?.expectLevelAbove !== undefined && !(r.probe.audio.level > spec.expectLevelAbove)) {
    console.error(
      `\n✗ ${r.shot}: voice level ${f(r.probe.audio.level, 3)} did not exceed ` +
        `${spec.expectLevelAbove} — the audio tap carried nothing`,
    );
    problems += 1;
  }
}

for (const r of results) {
  for (const m of r.messages) console.error(`\n✗ ${r.shot}: ${m}`);
}

if (transitions.length > 0) {
  console.log(
    `\ntransition progress ${TRANSITION_SAMPLE_MS}ms after the click ` +
      '(a hard cut reads ~1.0; the easing predicts roughly 0.3-0.4):',
  );
  for (const t of transitions) {
    console.log(`  ${`${t.from} -> ${t.to}`.padEnd(24)} ${f(t.progress, 3)}`);
  }
  // Both bounds matter: too high means it snapped, too low means the click
  // did nothing and the shot would have passed by accident.
  const snapped = transitions.filter((t) => t.progress > 0.6);
  const stalled = transitions.filter((t) => t.progress < 0.04);
  if (snapped.length > 0) {
    console.error(
      `\n✗ ${snapped.length} transition(s) snap rather than ease: ` +
        snapped.map((t) => `${t.from}->${t.to} (${f(t.progress, 2)})`).join(', '),
    );
    problems += snapped.length;
  }
  if (stalled.length > 0) {
    console.error(
      `\n✗ ${stalled.length} transition(s) never started: ` +
        stalled.map((t) => `${t.from}->${t.to} (${f(t.progress, 2)})`).join(', '),
    );
    problems += stalled.length;
  }
}

console.log(`\nwrote ${results.length} shot(s) to shots/`);
if (problems > 0) {
  console.error(`✗ ${problems} problem(s)`);
  process.exit(1);
}
console.log('✓ no console errors, every shot has content');
