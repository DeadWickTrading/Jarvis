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
import { decodePng, imageStats, meanAbsDiff } from './png.mjs';

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
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
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
  if (shot.state) await page.evaluate((s) => window.scene.setState(s), shot.state);
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
  const stats = imageStats(decodePng(buffer));

  // Take a second frame a beat later and diff it. A still scene and a moving
  // one look identical in a single screenshot; this is what distinguishes
  // "breathing gently" from "stopped".
  await page.waitForTimeout(900);
  const motion = meanAbsDiff(decodePng(buffer), decodePng(await page.screenshot({ type: 'png' })));

  if (messages.length > 0) problems += messages.length;
  results.push({ shot: shot.name, gl, probe, stats, motion, messages });
  await page.close();
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
for (const r of results) {
  for (const m of r.messages) console.error(`\n✗ ${r.shot}: ${m}`);
}

console.log(`\nwrote ${results.length} shot(s) to shots/`);
if (problems > 0) {
  console.error(`✗ ${problems} problem(s)`);
  process.exit(1);
}
console.log('✓ no console errors, every shot has content');
