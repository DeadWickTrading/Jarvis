/**
 * A minimal PNG reader, just enough to measure a screenshot.
 *
 * The screenshot harness needs to answer "did anything actually render?" and
 * "where is the light on screen?". Decoding the PNG ourselves keeps the repo
 * free of an image dependency for what amounts to an inflate and five filter
 * cases. Handles the 8-bit non-interlaced RGB/RGBA/grey output Chromium
 * produces, and nothing else.
 */
import { inflateSync } from 'node:zlib';

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

export function decodePng(buffer) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i += 1) {
    if (buffer[i] !== sig[i]) throw new Error('not a PNG');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
      if (body[12] !== 0) throw new Error('interlaced PNG is not supported');
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
  }

  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      const v = line[x];
      switch (filter) {
        case 0:
          cur[x] = v;
          break;
        case 1:
          cur[x] = (v + a) & 0xff;
          break;
        case 2:
          cur[x] = (v + b) & 0xff;
          break;
        case 3:
          cur[x] = (v + ((a + b) >> 1)) & 0xff;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          cur[x] = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default:
          throw new Error(`unknown PNG filter ${filter}`);
      }
    }
  }

  return { width, height, channels, data: out };
}

/** Rec. 709 luminance of one pixel, 0..1. */
function luma(data, i, channels) {
  if (channels <= 2) return data[i] / 255;
  return (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
}

/**
 * Summarise an image: overall brightness and spread, the share of pixels
 * clearly above the background, the mean channel mix, and a 3x3 brightness
 * grid. Enough to tell "nebula with a glow behind the centre" from "black".
 */
export function imageStats(png, { floor = 0.06 } = {}) {
  const { width, height, channels, data } = png;
  let sum = 0;
  let sumSq = 0;
  let lit = 0;
  let max = 0;
  const rgb = [0, 0, 0];
  const grid = Array.from({ length: 9 }, () => ({ sum: 0, n: 0 }));

  for (let y = 0; y < height; y += 1) {
    const gy = Math.min(2, Math.floor((y / height) * 3));
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      const l = luma(data, i, channels);
      sum += l;
      sumSq += l * l;
      if (l > max) max = l;
      if (l > floor) lit += 1;
      if (channels >= 3) {
        rgb[0] += data[i];
        rgb[1] += data[i + 1];
        rgb[2] += data[i + 2];
      }
      const cell = grid[gy * 3 + Math.min(2, Math.floor((x / width) * 3))];
      cell.sum += l;
      cell.n += 1;
    }
  }

  const n = width * height;
  const mean = sum / n;
  return {
    width,
    height,
    mean,
    stdDev: Math.sqrt(Math.max(0, sumSq / n - mean * mean)),
    max,
    litFraction: lit / n,
    meanRgb: rgb.map((v) => v / n / 255),
    grid: grid.map((c) => (c.n ? c.sum / c.n : 0)),
  };
}

/**
 * Mean absolute luminance difference between two same-sized images, 0..1.
 *
 * Used to prove the scene is animating: a frozen render diffs to zero against
 * itself a second later, however pretty the single frame looks.
 */
export function meanAbsDiff(a, b) {
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) {
    throw new Error('meanAbsDiff: images differ in size');
  }
  const n = a.width * a.height;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const o = i * a.channels;
    sum += Math.abs(luma(a.data, o, a.channels) - luma(b.data, o, b.channels));
  }
  return sum / n;
}

/**
 * Measure how round the bright points in an image are.
 *
 * Stars are only a few pixels across, so comparing lit run lengths quantises
 * hopelessly — a 3x2 blob reads as 1.5 whether or not anything is wrong.
 * Instead each bright blob is flood-filled and its intensity-weighted second
 * moments are taken, which is sensitive well below a pixel because the points
 * are anti-aliased. The returned figure is the median of sqrt(varX / varY)
 * over all blobs: 1 means round, far from 1 means stretched.
 *
 * The orb is excluded by ignoring a disc around the centre. Its wireframe
 * breaks into short bright arcs along the rim, and an arc is legitimately
 * elongated, so leaving them in drags the median toward "stretched" in
 * exactly the bright states where the orb is most visible.
 *
 * @param excludeCentre Radius of the ignored central disc, as a fraction of
 *   image height. The orb spans about 0.29 of the height and its halo about
 *   0.37, so the default clears both.
 */
export function pointAspectRatio(
  png,
  { threshold = 0.3, maxBlob = 64, maxPoints = 600, excludeCentre = 0.42 } = {},
) {
  const { width, height, channels, data } = png;
  const at = (x, y) => luma(data, (y * width + x) * channels, channels);
  const visited = new Uint8Array(width * height);
  const ratios = [];

  const cx = width / 2;
  const cy = height / 2;
  const excludeR2 = (excludeCentre * height) ** 2;

  for (let y = 1; y < height - 1 && ratios.length < maxPoints; y += 1) {
    for (let x = 1; x < width - 1 && ratios.length < maxPoints; x += 1) {
      const head = y * width + x;
      if (visited[head] || at(x, y) <= threshold) continue;
      if ((x - cx) ** 2 + (y - cy) ** 2 < excludeR2) continue;

      // Flood-fill this blob, collecting intensity-weighted moments.
      const stack = [head];
      visited[head] = 1;
      let w = 0;
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let syy = 0;
      let count = 0;
      let rejected = false;

      while (stack.length > 0) {
        const index = stack.pop();
        const px = index % width;
        const py = (index - px) / width;
        const v = at(px, py);
        w += v;
        sx += v * px;
        sy += v * py;
        sxx += v * px * px;
        syy += v * py * py;
        count += 1;
        // Anything this large is not a point star.
        if (count > maxBlob) {
          rejected = true;
          break;
        }
        for (const [nx, ny] of [
          [px - 1, py],
          [px + 1, py],
          [px, py - 1],
          [px, py + 1],
        ]) {
          if (nx < 1 || ny < 1 || nx >= width - 1 || ny >= height - 1) {
            // Runs off the frame, so its true extent is unknown.
            rejected = true;
            continue;
          }
          const n = ny * width + nx;
          if (!visited[n] && at(nx, ny) > threshold) {
            visited[n] = 1;
            stack.push(n);
          }
        }
      }

      if (rejected || count < 2 || w <= 0) continue;

      const meanX = sx / w;
      const meanY = sy / w;
      const varX = sxx / w - meanX * meanX;
      const varY = syy / w - meanY * meanY;
      // A blob one pixel wide in an axis has zero variance there; adding the
      // variance of a unit square keeps the ratio finite and comparable.
      const ratio = Math.sqrt((varX + 1 / 12) / (varY + 1 / 12));
      if (Number.isFinite(ratio)) ratios.push(ratio);
    }
  }

  if (ratios.length < 20) return null;
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor(ratios.length / 2)];
}
