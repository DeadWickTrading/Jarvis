/**
 * Print a coarse luminance map of a screenshot, as text.
 *
 * Eyeballing a near-black render is unreliable — faint banding in a preview is
 * as likely to be image scaling as it is to be a real artefact. This renders
 * the actual pixel values at a readable resolution so the difference is
 * decidable.
 *
 *   node scripts/probe.mjs shots/idle.png [cols] [rows]
 */
import { readFileSync } from 'node:fs';
import { decodePng } from './png.mjs';

const [file, colsArg, rowsArg] = process.argv.slice(2);
if (!file) {
  console.error('usage: node scripts/probe.mjs <file.png> [cols] [rows]');
  process.exit(2);
}
const cols = Number(colsArg) || 64;
const rows = Number(rowsArg) || 24;

const png = decodePng(readFileSync(file));
const { width, height, channels, data } = png;

const RAMP = ' .:-=+*#%@';
const cells = [];
let peak = 0;

for (let r = 0; r < rows; r += 1) {
  const row = [];
  for (let c = 0; c < cols; c += 1) {
    const x0 = Math.floor((c / cols) * width);
    const x1 = Math.max(x0 + 1, Math.floor(((c + 1) / cols) * width));
    const y0 = Math.floor((r / rows) * height);
    const y1 = Math.max(y0 + 1, Math.floor(((r + 1) / rows) * height));
    let sum = 0;
    let n = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const i = (y * width + x) * channels;
        sum +=
          channels >= 3
            ? (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255
            : data[i] / 255;
        n += 1;
      }
    }
    const v = sum / n;
    if (v > peak) peak = v;
    row.push(v);
  }
  cells.push(row);
}

console.log(`${file}  ${width}x${height}  peak cell ${peak.toFixed(3)}`);
for (const row of cells) {
  console.log(
    row
      .map((v) => RAMP[Math.min(RAMP.length - 1, Math.floor((v / Math.max(peak, 1e-6)) * RAMP.length))])
      .join(''),
  );
}

// A horizontal slice through the middle, in raw numbers, for spotting edges.
const midRow = Math.floor(height / 2);
const slice = [];
for (let c = 0; c < cols; c += 1) {
  const x = Math.floor((c / cols) * width);
  const i = (midRow * width + x) * channels;
  slice.push(
    channels >= 3
      ? (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255
      : data[i] / 255,
  );
}
console.log(`\nmid-row luminance (y=${midRow}):`);
console.log(slice.map((v) => v.toFixed(2).slice(1)).join(' '));
