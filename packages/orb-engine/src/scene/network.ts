import * as THREE from 'three';
import { BRAND, hexToRgb } from '../brand.js';
import { clamp01 } from '../easing.js';
import { buildGalaxy, thinGalaxy, type Galaxy } from '../layout.js';
import type { PerformanceTier } from '../types.js';
import { srgbColor } from './color.js';
import type { FrameContext, ScenePass } from './pass.js';

/** Share of the galaxy kept in each tier. The low tier is the same galaxy, thinned. */
const TIER_DENSITY: Record<PerformanceTier, number> = { high: 1, low: 0.55 };

/**
 * Falloff exponent for a node sprite.
 *
 * The brief asks for a bright core that is half as bright at 30% of the
 * radius and reaches nothing at the edge. For `(1 - d)^k` that fixes k:
 * 0.7^k = 0.5, so k = ln(0.5) / ln(0.7).
 */
const NODE_FALLOFF = Math.log(0.5) / Math.log(0.7);

/** A stable 0..1 hash of an integer, for per-node trade side and size. */
function tradeHash(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Line opacity at rest and at full voice. */
const LINK_OPACITY = { quiet: 0.12, loud: 0.65 } as const;

const POINT_VERTEX = /* glsl */ `
uniform float uSizeScale;
uniform float uNodeSize;

attribute float aSize;

varying vec3 vColor;

void main() {
  vColor = color;
  vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);

  // Perspective point size: uSizeScale carries the viewport height and the
  // camera's field of view, so a node shrinks with distance exactly as the
  // geometry around it does.
  gl_PointSize = aSize * uNodeSize * uSizeScale / max(0.001, -viewPosition.z);

  gl_Position = projectionMatrix * viewPosition;
}
`;

const POINT_FRAGMENT = /* glsl */ `
uniform float uBrightness;
uniform float uSquare;

varying vec3 vColor;

void main() {
  if (uSquare > 0.5) {
    // Trades print as squares: a solid block with a thin glow around it.
    vec2 q = abs(gl_PointCoord - vec2(0.5)) * 2.0;
    float m = max(q.x, q.y);
    float block = m < 0.5 ? 1.0 : pow(max(0.0, 1.0 - (m - 0.5) / 0.5), 2.0) * 0.35;
    gl_FragColor = vec4(vColor * block * uBrightness, 1.0);
    return;
  }
  // gl_PointCoord runs 0..1 across the sprite; this is the distance from the
  // centre as a fraction of the radius.
  float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
  if (d > 1.0) discard;

  // No texture: the falloff is the shader. Bright core, half-bright at 30%
  // of the radius, nothing at the edge.
  float intensity = pow(1.0 - d, ${NODE_FALLOFF.toFixed(4)}) * uBrightness;
  gl_FragColor = vec4(vColor * intensity, 1.0);
}
`;

/**
 * Layer 3: the star network.
 *
 * Eight clusters of coloured lights on a shell around the middle, joined by
 * faint lines wherever two nodes happen to be near each other, with stray
 * nodes and a dust field filling the space between. Its own 60-degree camera
 * sits 42 units back, and it draws between the sky and the orb, so the
 * constellation turns around and through the orb rather than behind it.
 */
export class NetworkPass implements ScenePass {
  readonly name = 'network';
  readonly clearDepthBefore = false;

  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly group = new THREE.Group();

  private readonly full: Galaxy;
  private tier: PerformanceTier;

  private nodes!: THREE.Points;
  private links!: THREE.LineSegments;
  private dust!: THREE.Points;

  private readonly nodeMaterial: THREE.ShaderMaterial;
  private readonly dustMaterial: THREE.ShaderMaterial;
  private readonly linkMaterial: THREE.LineBasicMaterial;

  private spin = 0;
  private height = 1;

  private readonly trades: boolean;

  constructor(tier: PerformanceTier, seed?: number, trades = false) {
    this.tier = tier;
    this.trades = trades;
    this.full = buildGalaxy(seed === undefined ? {} : { seed });

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 400);
    this.camera.position.set(0, 0, 42);

    this.nodeMaterial = new THREE.ShaderMaterial({
      vertexShader: POINT_VERTEX,
      fragmentShader: POINT_FRAGMENT,
      uniforms: {
        uSizeScale: { value: 700 },
        uNodeSize: { value: 0.42 },
        uBrightness: { value: 0.8 },
        uSquare: { value: trades ? 1 : 0 },
      },
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.dustMaterial = this.nodeMaterial.clone();
    this.dustMaterial.uniforms.uSquare!.value = 0;
    this.dustMaterial.uniforms.uNodeSize!.value = 0.16;
    this.dustMaterial.uniforms.uBrightness!.value = 0.5;

    this.linkMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: LINK_OPACITY.quiet,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.build();
    this.scene.add(this.group);
  }

  /** Build the buffers for the current tier's slice of the galaxy. */
  private build(): void {
    const galaxy = thinGalaxy(this.full, TIER_DENSITY[this.tier]);

    // --- nodes -------------------------------------------------------------
    const count = galaxy.nodes.length;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const colour = new THREE.Color();
    const buy = hexToRgb(BRAND.accent);
    const sell = hexToRgb(BRAND.error);
    const side: boolean[] = [];

    galaxy.nodes.forEach((node, i) => {
      if (this.trades) {
        // Deterministic per node, so the same galaxy prints the same tape.
        const r1 = tradeHash(i * 2 + 1);
        const r2 = tradeHash(i * 2 + 2);
        const isBuy = r1 < 0.5;
        side[i] = isBuy;
        positions[i * 3] = node.position[0];
        positions[i * 3 + 1] = node.position[1];
        positions[i * 3 + 2] = node.position[2];
        srgbColor(isBuy ? buy : sell).getRGB(colour);
        colors[i * 3] = colour.r;
        colors[i * 3 + 1] = colour.g;
        colors[i * 3 + 2] = colour.b;
        // Heavy tail: most prints small, a handful of block trades.
        sizes[i] = node.size * (1.1 + 7 * r2 ** 4);
        return;
      }
      positions[i * 3] = node.position[0];
      positions[i * 3 + 1] = node.position[1];
      positions[i * 3 + 2] = node.position[2];
      srgbColor(node.color).getRGB(colour);
      colors[i * 3] = colour.r;
      colors[i * 3 + 1] = colour.g;
      colors[i * 3 + 2] = colour.b;
      sizes[i] = node.size;
    });

    const nodeGeometry = new THREE.BufferGeometry();
    nodeGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    nodeGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    nodeGeometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    this.nodes = new THREE.Points(nodeGeometry, this.nodeMaterial);
    this.group.add(this.nodes);

    // --- links ---------------------------------------------------------------
    const linkPositions = new Float32Array(galaxy.links.length * 6);
    const linkColors = new Float32Array(galaxy.links.length * 6);
    galaxy.links.forEach((link, i) => {
      const a = galaxy.nodes[link.a]!.position;
      const b = galaxy.nodes[link.b]!.position;
      linkPositions.set(a, i * 6);
      linkPositions.set(b, i * 6 + 3);
      const lineColour = this.trades
        ? srgbColor(side[link.a] === side[link.b] ? (side[link.a] ? buy : sell) : hexToRgb(BRAND.dim))
        : srgbColor(link.color);
      linkColors.set([lineColour.r, lineColour.g, lineColour.b], i * 6);
      linkColors.set([lineColour.r, lineColour.g, lineColour.b], i * 6 + 3);
    });

    const linkGeometry = new THREE.BufferGeometry();
    linkGeometry.setAttribute('position', new THREE.BufferAttribute(linkPositions, 3));
    linkGeometry.setAttribute('color', new THREE.BufferAttribute(linkColors, 3));
    this.links = new THREE.LineSegments(linkGeometry, this.linkMaterial);
    this.group.add(this.links);

    // --- dust ----------------------------------------------------------------
    const dustCount = galaxy.dust.length / 3;
    const dustColors = new Float32Array(galaxy.dust.length);
    const dustSizes = new Float32Array(dustCount);
    const dim = srgbColor(hexToRgb(BRAND.dim));
    for (let i = 0; i < dustCount; i += 1) {
      dustColors[i * 3] = dim.r;
      dustColors[i * 3 + 1] = dim.g;
      dustColors[i * 3 + 2] = dim.b;
      dustSizes[i] = 1;
    }

    const dustGeometry = new THREE.BufferGeometry();
    // subarray shares the full galaxy's buffer, so copy before handing it to GL.
    dustGeometry.setAttribute('position', new THREE.BufferAttribute(galaxy.dust.slice(), 3));
    dustGeometry.setAttribute('color', new THREE.BufferAttribute(dustColors, 3));
    dustGeometry.setAttribute('aSize', new THREE.BufferAttribute(dustSizes, 1));
    this.dust = new THREE.Points(dustGeometry, this.dustMaterial);
    this.group.add(this.dust);
  }

  private teardownBuffers(): void {
    for (const object of [this.nodes, this.links, this.dust]) {
      this.group.remove(object);
      object.geometry.dispose();
    }
  }

  update(ctx: FrameContext): void {
    // The galaxy answers the AI, not the user: networkGain is zero while
    // listening, so a loud user moves the orb and nothing else.
    const response = clamp01(ctx.audio.level * ctx.params.networkGain);

    this.linkMaterial.opacity =
      LINK_OPACITY.quiet + (LINK_OPACITY.loud - LINK_OPACITY.quiet) * response;

    this.nodeMaterial.uniforms.uNodeSize!.value = 0.42 * (1 + response * 0.45);
    this.nodeMaterial.uniforms.uBrightness!.value = 0.8 + response * 0.9;
    this.dustMaterial.uniforms.uBrightness!.value = 0.5 + response * 0.3;

    // Very slow turn, a little faster when there is something to say.
    this.spin += (0.012 + response * 0.03) * ctx.dt;
    this.group.rotation.y = this.spin;
    // A gentle tilt back and forth, measured in minutes.
    this.group.rotation.x = Math.sin(ctx.animTime * 0.047) * 0.14;
    this.group.scale.setScalar(1 + response * 0.04);

    // The camera drifts a couple of units over minutes, pushes in slightly
    // while the AI talks, and shakes just enough to feel rather than see.
    const shake = Math.sin(ctx.animTime * 37.4) * 0.05 * response;
    this.camera.position.set(
      Math.sin(ctx.animTime * 0.013) * 2 + shake,
      Math.cos(ctx.animTime * 0.011) * 1.4 + Math.cos(ctx.animTime * 41.2) * 0.05 * response,
      42 - response * 2.6 + Math.sin(ctx.animTime * 0.009) * 0.8,
    );
    this.camera.lookAt(0, 0, 0);
  }

  render(renderer: THREE.WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }

  resize(width: number, height: number): void {
    this.height = Math.max(1, height);
    this.camera.aspect = height > 0 ? width / height : 1;
    this.camera.updateProjectionMatrix();

    // Point size is in device pixels, so it has to be derived from the
    // viewport height and the vertical field of view, or nodes change
    // apparent size whenever the window does.
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    this.nodeMaterial.uniforms.uSizeScale!.value = this.height / (2 * Math.tan(halfFov));
    this.dustMaterial.uniforms.uSizeScale!.value =
      this.nodeMaterial.uniforms.uSizeScale!.value;
  }

  setTier(tier: PerformanceTier): void {
    if (tier === this.tier) return;
    this.tier = tier;
    this.teardownBuffers();
    this.build();
  }

  dispose(): void {
    this.teardownBuffers();
    this.nodeMaterial.dispose();
    this.dustMaterial.dispose();
    this.linkMaterial.dispose();
    this.scene.clear();
  }
}
