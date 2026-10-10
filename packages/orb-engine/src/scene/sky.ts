import * as THREE from 'three';
import { BRAND, CLUSTER_HUES, hexToRgb, mixRgb } from '../brand.js';
import { VALUE_NOISE_2D } from '../shaders/noise.js';
import type { PerformanceTier } from '../types.js';
import { srgbColor } from './color.js';
import type { FrameContext, ScenePass } from './pass.js';

/** fBm octaves per tier. The nebula is the most per-pixel-expensive thing here. */
const FBM_OCTAVES: Record<PerformanceTier, number> = { high: 5, low: 3 };

const SKY_VERTEX = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  // A plane spanning -1..1 written straight to clip space: no camera, no
  // matrices, nothing to keep in sync with a resize.
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const SKY_FRAGMENT = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uAspect;
uniform float uSkyGain;
uniform float uLevel;
uniform float uBass;

uniform vec3 uInk;
uniform vec3 uNebulaTeal;
uniform vec3 uNebulaViolet;
uniform vec3 uNebulaBlue;
uniform vec3 uOrbColor;
uniform vec3 uCore;
uniform vec3 uStar;

varying vec2 vUv;

${VALUE_NOISE_2D}

/**
 * One layer of stars on a hashed grid.
 *
 * 'p' arrives aspect-corrected so the cells are square on screen. Sampling in
 * raw UV instead stretches every star into a short dash the moment the window
 * stops being 1:1.
 */
vec3 starLayer(vec2 p, float density, float radius, float sparsity, float speed, float salt) {
  vec2 grid = p * density;
  vec2 cell = floor(grid);
  vec2 local = fract(grid) - 0.5;

  float pick = hash12(cell + salt);
  // Most cells hold nothing; otherwise the sky reads as a regular lattice.
  float present = step(sparsity, pick);

  vec2 jitter = vec2(hash12(cell + salt + 17.3), hash12(cell + salt + 41.7)) - 0.5;
  float d = length(local - jitter * 0.72);

  float core = smoothstep(radius, 0.0, d);
  float twinkle = 0.55 + 0.45 * sin(uTime * speed + pick * 62.83);
  float brightness = pow(pick, 2.5);

  return uStar * core * twinkle * brightness * present;
}

void main() {
  // Centred and aspect-corrected: distances are circular on screen.
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float r = length(p);

  // Deep space base, a touch darker toward the edges.
  vec3 col = uInk * (1.0 - 0.3 * smoothstep(0.1, 0.85, r));

  // --- nebula -------------------------------------------------------------
  // Glacial: a full unit of drift takes well over a minute.
  float t = uTime * 0.009;

  // The screen only spans about 1.6 x 1.0 in p, so the noise has to be
  // sampled over a much wider domain than that or every feature is larger
  // than the viewport and the nebula flattens into a single smooth wash.
  vec2 q = p * 3.0;

  float wisp1 = fbm(q * 2.3 + vec2(t, t * 0.63));
  float wisp2 = fbm(q * 1.7 + vec2(-t * 0.74, t * 0.41) + 11.3);
  float wisp3 = fbm(q * 3.1 + vec2(t * 0.52, -t * 0.68) + 41.7);

  // A soft threshold is what turns fBm from flat fog into wisps: everything
  // below the knee is discarded, so only the ridges survive. fBm rarely gets
  // near 1, so the upper edge sits well short of it or nothing ever lights.
  float gain = uSkyGain * (0.85 + uLevel * 0.55 + uBass * 0.2);
  col += uNebulaTeal * smoothstep(0.53, 0.87, wisp1) * 0.64 * gain;
  col += uNebulaViolet * smoothstep(0.56, 0.91, wisp2) * 0.56 * gain;
  col += uNebulaBlue * smoothstep(0.54, 0.89, wisp3) * 0.46 * gain;

  // --- bloom behind the orb ------------------------------------------------
  // Three falloffs rather than one: a wide wash, a tighter halo and a small
  // hot centre read as depth, where a single gaussian reads as a sticker.
  float r2 = r * r;
  float bloom = exp(-r2 * 5.5) * 0.065 + exp(-r2 * 16.0) * 0.060 + exp(-r2 * 48.0) * 0.055;
  col += uOrbColor * bloom * uSkyGain * (0.45 + uLevel * 0.6 + uBass * 0.25);
  col += uCore * exp(-r2 * 260.0) * uSkyGain * (0.28 + uLevel * 0.7);

  // --- stars ---------------------------------------------------------------
  col += starLayer(p, 150.0, 0.28, 0.968, 1.7, 0.0) * 0.85;
  col += starLayer(p, 46.0, 0.16, 0.935, 0.9, 93.1) * 0.6;

  // --- vignette ------------------------------------------------------------
  col *= 1.0 - 0.42 * smoothstep(0.33, 1.05, r);

  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * Layer 2: the sky.
 *
 * A single full-screen quad drawn before everything else with depth testing
 * off, so it needs no camera of its own and cannot be occluded. Deep-space
 * base, three drifting nebula layers, a bloom in the orb's current colour
 * behind the centre, two star fields and a vignette.
 */
export class SkyPass implements ScenePass {
  readonly name = 'sky';
  readonly clearDepthBefore = false;

  private readonly scene = new THREE.Scene();
  /** Identity camera: the vertex shader writes clip space directly. */
  private readonly camera = new THREE.Camera();
  private readonly geometry = new THREE.PlaneGeometry(2, 2);
  private readonly material: THREE.ShaderMaterial;

  constructor(tier: PerformanceTier) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      defines: { FBM_OCTAVES: FBM_OCTAVES[tier] },
      uniforms: {
        uTime: { value: 0 },
        uAspect: { value: 1 },
        uSkyGain: { value: 0.5 },
        uLevel: { value: 0 },
        uBass: { value: 0 },
        uInk: { value: srgbColor(hexToRgb(BRAND.ink)) },
        uNebulaTeal: { value: srgbColor(hexToRgb(BRAND.success)) },
        uNebulaViolet: { value: srgbColor(hexToRgb(BRAND.secondary)) },
        uNebulaBlue: { value: srgbColor(hexToRgb(CLUSTER_HUES[2])) },
        uOrbColor: { value: srgbColor(hexToRgb(BRAND.accent)) },
        // A small pale-cyan centre, so the bloom has a hotter core than its wash.
        uCore: { value: srgbColor(mixRgb(hexToRgb(BRAND.cyan), [1, 1, 1], 0.55)) },
        uStar: { value: srgbColor(mixRgb(hexToRgb(BRAND.text), [1, 1, 1], 0.4)) },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.scene.add(new THREE.Mesh(this.geometry, this.material));
  }

  update(ctx: FrameContext): void {
    const u = this.material.uniforms;
    u.uTime!.value = ctx.animTime;
    u.uSkyGain!.value = ctx.params.skyGain;
    // The sky answers the AI's voice, not the user's: networkGain is zero
    // while listening, which keeps the nebula still as the orb lights up.
    u.uLevel!.value = ctx.audio.level * ctx.params.networkGain;
    u.uBass!.value = ctx.audio.bass * ctx.params.networkGain;
    (u.uOrbColor!.value as THREE.Color).setRGB(
      ctx.color[0],
      ctx.color[1],
      ctx.color[2],
      THREE.SRGBColorSpace,
    );
  }

  render(renderer: THREE.WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }

  resize(width: number, height: number): void {
    this.material.uniforms.uAspect!.value = this.forceSquareAspect
      ? 1
      : height > 0
        ? width / height
        : 1;
  }

  /**
   * Test hook: pin the aspect uniform to 1, which is exactly the bug the
   * aspect correction exists to prevent. Lets the screenshot harness confirm
   * its star-roundness check can see a stretched field, rather than trusting
   * that a passing number means anything.
   */
  forceSquareAspect = false;

  setTier(tier: PerformanceTier): void {
    const octaves = FBM_OCTAVES[tier];
    if (this.material.defines!.FBM_OCTAVES === octaves) return;
    this.material.defines!.FBM_OCTAVES = octaves;
    this.material.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.scene.clear();
  }
}
