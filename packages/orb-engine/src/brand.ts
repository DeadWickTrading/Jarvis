/**
 * The single source of truth for every colour in the system.
 *
 * Nothing else in this repo may contain a colour literal. The CSS custom
 * properties the demo UI uses are generated from this file by
 * `scripts/gen-tokens.mjs`, and `npm run lint:tokens` fails the build if the
 * generated file drifts or if a stray hex appears anywhere else.
 */

/** Deadwick brand palette. */
export const BRAND = {
  /** Wick lime — the accent. Orb at idle and while speaking. */
  accent: '#5CF03D',
  /** P2P violet — the secondary. Where colour flows to while thinking. */
  secondary: '#A44DFF',
  /** Amber — the recording light. The only warm thing in a cool universe. */
  listening: '#FFB21E',
  /** Red — error. */
  error: '#F2385A',
  /** Teal — success / positive. Used as a cool undertone on the orb. */
  success: '#12B886',
  /** Cyan — extra cool tone for clusters and star cores. */
  cyan: '#3DD9F0',

  /** Background ink — the deep-space base. */
  ink: '#0D1016',
  /** Panel surface. */
  panel: '#161A23',
  /** Hairline border. */
  border: '#262C3A',

  /** Primary text. */
  text: '#ECEEF3',
  /** Muted text. */
  muted: '#9AA1B2',
  /** Dim text — also the colour of stray nodes and dust. */
  dim: '#6B7285',
} as const;

/**
 * Eight cool hues, one per star cluster, anchored on the brand palette:
 * teal, cyan, blue, violet, green-teal, indigo, blue-teal, deep violet.
 * Ordered so that a thinned performance-mode galaxy keeps the same first
 * clusters and therefore the same overall colour balance.
 */
export const CLUSTER_HUES = [
  BRAND.success, // teal
  BRAND.cyan, // cyan
  '#3D8AF0', // blue
  BRAND.secondary, // violet
  '#3DF0A8', // green-teal
  '#5C6BF0', // indigo
  '#2FC8D9', // blue-teal
  '#8347E0', // deep violet
] as const;

/** A colour as three components in the 0..1 range. */
export type Rgb = readonly [number, number, number];

/** Parse `#rgb` or `#rrggbb` into 0..1 components. Throws on malformed input. */
export function hexToRgb(hex: string): Rgb {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`hexToRgb: not a hex colour: ${JSON.stringify(hex)}`);
  let body = m[1];
  if (body.length === 3) {
    body = body[0] + body[0] + body[1] + body[1] + body[2] + body[2];
  }
  const n = Number.parseInt(body, 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

/** Format 0..1 components back to `#rrggbb`. Clamps out-of-range input. */
export function rgbToHex(rgb: Rgb): string {
  const part = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${part(rgb[0])}${part(rgb[1])}${part(rgb[2])}`;
}

/**
 * Linear blend between two colours; `t` is clamped to 0..1.
 *
 * The endpoints are returned exactly. `a + (b - a) * 1` is not identically `b`
 * in floating point, and a colour cycle that reaches the end of its travel
 * should land on the colour the state table names, not near it.
 */
export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const k = Math.min(1, Math.max(0, t));
  if (k === 0) return [a[0], a[1], a[2]];
  if (k === 1) return [b[0], b[1], b[2]];
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}
