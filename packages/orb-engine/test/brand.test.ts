import { describe, expect, it } from 'vitest';
import { BRAND, CLUSTER_HUES, hexToRgb, mixRgb, rgbToHex } from '../src/brand.js';

describe('the palette', () => {
  it('is all valid six-digit hex', () => {
    for (const [name, hex] of Object.entries(BRAND)) {
      expect(hex, name).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
    for (const hex of CLUSTER_HUES) expect(hex).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('has one hue per cluster, all distinct', () => {
    expect(CLUSTER_HUES).toHaveLength(8);
    expect(new Set(CLUSTER_HUES).size).toBe(8);
  });

  it('keeps the cluster hues cool, so the warm listening state stands alone', () => {
    for (const hex of CLUSTER_HUES) {
      const [r, g, b] = hexToRgb(hex);
      expect(Math.max(g, b), hex).toBeGreaterThan(r);
    }
  });

  it('keeps the surfaces dark and the text light', () => {
    const luma = (hex: string) => {
      const [r, g, b] = hexToRgb(hex);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    // Surfaces climb: the background is darkest, the panel sits above it and
    // the hairline above that, or the border would be invisible on the panel.
    expect(luma(BRAND.ink)).toBeLessThan(luma(BRAND.panel));
    expect(luma(BRAND.panel)).toBeLessThan(luma(BRAND.border));
    // All of them still need to be unambiguously dark surfaces.
    expect(luma(BRAND.border)).toBeLessThan(0.25);
    // And the text has to carry against them.
    expect(luma(BRAND.text)).toBeGreaterThan(0.8);
    expect(luma(BRAND.dim)).toBeGreaterThan(luma(BRAND.border));
  });
});

describe('hexToRgb', () => {
  it('parses six-digit hex', () => {
    expect(hexToRgb('#000000')).toEqual([0, 0, 0]);
    expect(hexToRgb('#ffffff')).toEqual([1, 1, 1]);
    expect(hexToRgb('#FF0000')).toEqual([1, 0, 0]);
  });

  it('expands three-digit hex', () => {
    expect(hexToRgb('#fff')).toEqual(hexToRgb('#ffffff'));
    expect(hexToRgb('#0f8')).toEqual(hexToRgb('#00ff88'));
  });

  it('tolerates surrounding whitespace but rejects anything else', () => {
    expect(hexToRgb('  #fff  ')).toEqual([1, 1, 1]);
    for (const bad of ['fff', '#ff', '#ffff', '#gggggg', 'rebeccapurple', '']) {
      expect(() => hexToRgb(bad), bad).toThrow(/not a hex colour/);
    }
  });

  it('round-trips through rgbToHex for every brand colour', () => {
    for (const hex of Object.values(BRAND)) {
      expect(rgbToHex(hexToRgb(hex)).toLowerCase()).toBe(hex.toLowerCase());
    }
  });
});

describe('rgbToHex', () => {
  it('clamps out-of-range components rather than wrapping', () => {
    expect(rgbToHex([2, -1, 0.5])).toBe('#ff0080');
  });
});

describe('mixRgb', () => {
  it('returns the endpoints at 0 and 1', () => {
    const a = hexToRgb(BRAND.accent);
    const b = hexToRgb(BRAND.secondary);
    expect(mixRgb(a, b, 0)).toEqual(a);
    expect(mixRgb(a, b, 1)).toEqual(b);
  });

  it('is linear in between and clamps beyond', () => {
    expect(mixRgb([0, 0, 0], [1, 1, 1], 0.25)).toEqual([0.25, 0.25, 0.25]);
    expect(mixRgb([0, 0, 0], [1, 1, 1], 5)).toEqual([1, 1, 1]);
    expect(mixRgb([0, 0, 0], [1, 1, 1], -5)).toEqual([0, 0, 0]);
  });
});
