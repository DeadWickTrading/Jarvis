import { describe, expect, it } from 'vitest';
import { decodePcm16, floatToInt16, int16ToFloat, rms } from '../src/agent/pcm.js';

describe('floatToInt16', () => {
  it('maps the full range without clipping the top or wasting the bottom', () => {
    const out = floatToInt16(new Float32Array([-1, 0, 1]));
    expect([...out]).toEqual([-32_768, 0, 32_767]);
  });

  it('clamps rather than wrapping when gain has pushed samples out of range', () => {
    // Web Audio does not guarantee -1..1 once a gain node is involved, and a
    // wrapped sample is a loud click.
    const out = floatToInt16(new Float32Array([-4, 2.5]));
    expect([...out]).toEqual([-32_768, 32_767]);
  });

  it('rounds rather than truncating', () => {
    const out = floatToInt16(new Float32Array([0.00002]));
    expect(out[0]).toBe(1);
  });

  it('handles an empty block', () => {
    expect(floatToInt16(new Float32Array(0)).length).toBe(0);
  });
});

describe('int16ToFloat', () => {
  it('is the inverse at the extremes', () => {
    const out = int16ToFloat(new Int16Array([-32_768, 0, 32_767]));
    expect([...out]).toEqual([-1, 0, 1]);
  });

  it('round-trips a signal within a sample of itself', () => {
    const original = Float32Array.from({ length: 512 }, (_, i) => Math.sin(i / 8) * 0.9);
    const restored = int16ToFloat(floatToInt16(original));
    for (let i = 0; i < original.length; i += 1) {
      expect(Math.abs(restored[i]! - original[i]!)).toBeLessThan(1 / 32_000);
    }
  });
});

describe('decodePcm16', () => {
  it('reads little-endian samples off the wire', () => {
    // 0x0100 little-endian is 1; 0xFFFF is -1.
    const bytes = new Uint8Array([0x01, 0x00, 0xff, 0xff]).buffer;
    const out = decodePcm16(bytes);
    expect(out.length).toBe(2);
    expect(out[0]).toBeCloseTo(1 / 32_767, 9);
    expect(out[1]).toBeCloseTo(-1 / 32_768, 9);
  });

  it('respects the offset of a view rather than reading the whole buffer', () => {
    const backing = new Uint8Array([0xff, 0xff, 0x01, 0x00, 0x02, 0x00]);
    const view = new Uint8Array(backing.buffer, 2, 4);
    const out = decodePcm16(view);
    expect(out.length).toBe(2);
    expect(out[0]).toBeGreaterThan(0);
  });

  it('drops a trailing half sample instead of reading past the end', () => {
    // A WebSocket frame can split a sample across two messages.
    const bytes = new Uint8Array([0x01, 0x00, 0x7f]).buffer;
    expect(() => decodePcm16(bytes)).not.toThrow();
    expect(decodePcm16(bytes).length).toBe(1);
  });

  it('returns nothing for an empty frame', () => {
    expect(decodePcm16(new ArrayBuffer(0)).length).toBe(0);
  });
});

describe('rms', () => {
  it('is zero for silence and one for a full-scale square wave', () => {
    expect(rms(new Float32Array(128))).toBe(0);
    expect(rms(Float32Array.from({ length: 128 }, (_, i) => (i % 2 ? 1 : -1)))).toBeCloseTo(1, 9);
  });

  it('is about 0.707 for a full-scale sine', () => {
    const sine = Float32Array.from({ length: 1024 }, (_, i) => Math.sin((i / 1024) * Math.PI * 2));
    expect(rms(sine)).toBeCloseTo(Math.SQRT1_2, 2);
  });

  it('handles an empty block', () => {
    expect(rms(new Float32Array(0))).toBe(0);
  });
});
