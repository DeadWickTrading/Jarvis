import * as THREE from 'three';
import type { Rgb } from '../brand.js';

/**
 * Write an sRGB colour into a three.js `Color`.
 *
 * three.js keeps colours in a linear working space and applies the sRGB
 * transfer function on output. `Color.setRGB(r, g, b)` with no colour space
 * therefore reads its arguments as *linear*, so handing it a hex-derived
 * value straight from the brand palette makes everything far too bright: the
 * near-black background ink comes out as a mid grey, and the whole scene with
 * it.
 *
 * Every colour in this engine originates as a hex string, which is sRGB, so
 * every colour goes through here.
 */
export function setSrgb(target: THREE.Color, rgb: Rgb | readonly [number, number, number]): THREE.Color {
  return target.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
}

/** A new `Color` from an sRGB triple. */
export function srgbColor(rgb: Rgb | readonly [number, number, number]): THREE.Color {
  return setSrgb(new THREE.Color(), rgb);
}
