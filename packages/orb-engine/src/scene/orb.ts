import * as THREE from 'three';
import { SIMPLEX_3D } from '../shaders/noise.js';
import { setSrgb, srgbColor } from './color.js';
import type { OrbShape, PerformanceTier } from '../types.js';
import type { FrameContext, ScenePass } from './pass.js';
import { buildCatGeometry, CAT_DEPTH, CAT_EYES } from './cat.js';
import { TradeBands } from './trades.js';
import { BRAND, hexToRgb } from '../brand.js';
import { clamp01 } from '../easing.js';

/** Icosahedron subdivision per tier. 24 reads as a fine mesh; 10 still reads. */
const ORB_DETAIL: Record<PerformanceTier, number> = { high: 24, low: 10 };

/**
 * The wick silhouette: a rounded box (superellipsoid) for the body. Half
 * extents and squareness; higher N gives sharper corners.
 */
const WICK_BODY = { a: 0.42, b: 0.78, c: 0.42, n: 6 } as const;
/** Wick above and below the body: [top, bottom] as y extents, and the radius. */
const WICK_LINE = { top: 1.42, bottom: -1.3, radius: 0.028 } as const;
/** The whole candle is drawn a little smaller so the wicks clear the frame. */
const WICK_SCALE = 0.9;

/**
 * Bend a sphere into the candle body. Each vertex keeps its direction but is
 * pushed onto the superellipsoid surface, and its normal becomes the surface
 * gradient there, so the noise displacement and the rim shading both follow
 * the new shape without seams.
 */
function toWickBody(geometry: THREE.BufferGeometry): void {
  const { a, b, c, n } = WICK_BODY;
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const nor = geometry.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i += 1) {
    const dx = pos.getX(i);
    const dy = pos.getY(i);
    const dz = pos.getZ(i);
    const sum = Math.abs(dx / a) ** n + Math.abs(dy / b) ** n + Math.abs(dz / c) ** n;
    const t = sum > 0 ? sum ** (-1 / n) : 0;
    const x = dx * t;
    const y = dy * t;
    const z = dz * t;
    pos.setXYZ(i, x, y, z);
    const gx = (Math.sign(x) * Math.abs(x / a) ** (n - 1)) / a;
    const gy = (Math.sign(y) * Math.abs(y / b) ** (n - 1)) / b;
    const gz = (Math.sign(z) * Math.abs(z / c) ** (n - 1)) / c;
    const len = Math.hypot(gx, gy, gz) || 1;
    nor.setXYZ(i, gx / len, gy / len, gz / len);
  }
  pos.needsUpdate = true;
  nor.needsUpdate = true;
}

/** The three orbital rings: radius, tilt about x, tilt about y, spin rate. */
const RINGS = [
  { radius: 1.55, tiltX: 1.18, tiltY: 0.2, speed: 0.34 },
  { radius: 1.65, tiltX: 0.52, tiltY: -0.68, speed: -0.23 },
  { radius: 1.75, tiltX: -0.78, tiltY: 0.95, speed: 0.15 },
] as const;

const ORB_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uNoiseTime;
uniform float uActivity;
uniform float uBass;
uniform float uAudioActive;
uniform float uShapeAmp;

varying float vDisp;
varying vec3 vNormalView;
varying vec3 vViewDir;

${SIMPLEX_3D}

void main() {
  // Three octaves. The low one gives the shape its slow wander, the mid one
  // the surface texture, and the high one only switches on with audio: at
  // rest it would be visual noise for its own sake.
  float n1 = snoise(position * 1.6 + vec3(0.0, 0.0, uNoiseTime));
  float n2 = snoise(position * 3.4 + vec3(uNoiseTime * 0.8, 0.0, 0.0));
  float n3 = snoise(position * 7.1 + vec3(0.0, uNoiseTime * 1.3, 0.0));
  float noiseSum = n1 * 0.5 + n2 * 0.3 + n3 * 0.2 * uAudioActive;

  // The whole noise field is scaled by how much is actually going on. This is
  // what keeps the orb calm: in silence uActivity is small, so however busy
  // the noise is, the mesh barely moves.
  float displacement = noiseSum * uActivity * uShapeAmp;

  // A travelling wave so a bass hit reads as a push through the body rather
  // than as uniform swelling.
  displacement += sin(position.y * 3.0 + uTime * 2.0) * uBass * 0.06;

  displacement = clamp(displacement, -0.45, 0.45);

  vec3 displaced = position + normal * displacement;
  vec4 viewPosition = modelViewMatrix * vec4(displaced, 1.0);

  vDisp = displacement;
  vNormalView = normalize(normalMatrix * normal);
  vViewDir = normalize(-viewPosition.xyz);

  gl_Position = projectionMatrix * viewPosition;
}
`;

const ORB_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uColorSecondary;
uniform float uOpacity;
uniform float uFresnelPower;
uniform float uGlow;
uniform float uTintScale;
uniform float uFloor;

varying float vDisp;
varying vec3 vNormalView;
varying vec3 vViewDir;

void main() {
  // abs() because the wireframe shows both the near and far side of the mesh,
  // and the far side's normals point away from us.
  float facing = abs(dot(normalize(vNormalView), normalize(vViewDir)));
  float fresnel = pow(1.0 - facing, uFresnelPower);

  // Parts pushed outward lean toward the secondary colour.
  float tint = clamp(vDisp * uTintScale, 0.0, 1.0);
  vec3 tinted = mix(uColor, uColorSecondary, tint);

  // A small floor keeps the mesh faintly readable across the whole sphere;
  // the rim is where the brightness lives, so the face we look straight at is
  // close to invisible and the silhouette reads as a thin bright edge.
  float strength = uOpacity * (uFloor + (1.0 - uFloor) * fresnel) * (0.45 + uGlow * 0.5);

  // Additive blending multiplies the source by its own alpha, so anything put
  // in the alpha channel would be applied twice. The magnitude belongs in the
  // colour; alpha stays at 1.
  gl_FragColor = vec4(tinted * strength, 1.0);
}
`;

/**
 * A dark, see-through body behind the wireframe, for the solid shapes (wick,
 * cat). Shares the wireframe's uniforms and vertex shader, so it ripples with it.
 */
const FILL_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uColorSecondary;
uniform float uTintScale;

varying float vDisp;
varying vec3 vNormalView;
varying vec3 vViewDir;

void main() {
  float tint = clamp(vDisp * uTintScale, 0.0, 1.0);
  vec3 c = mix(uColor, uColorSecondary, tint);
  gl_FragColor = vec4(c * 0.42, 0.55);
}
`;

const GLOW_VERTEX = /* glsl */ `
varying vec3 vNormalView;
varying vec3 vViewDir;

void main() {
  vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
  vNormalView = normalize(normalMatrix * normal);
  vViewDir = normalize(-viewPosition.xyz);
  gl_Position = projectionMatrix * viewPosition;
}
`;

/**
 * Where the glow band peaks, as a view-angle cosine.
 *
 * The shell has radius 1.3 and the orb 1.0, so the shell's surface projects
 * onto the orb's silhouette at facing = sqrt(1 - (1.0 / 1.3)^2) = 0.639. That
 * is the ring of the shell that sits exactly at the orb's edge on screen.
 */
const GLOW_BAND_CENTER = Math.sqrt(1 - (1 / 1.3) ** 2);

const GLOW_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uStrength;
uniform float uBandWidth;

varying vec3 vNormalView;
varying vec3 vViewDir;

void main() {
  // Rendered back-faces-only, so this shades the far hemisphere of a shell
  // larger than the orb. 'facing' runs from 0 at the shell's silhouette to 1
  // at the centre of its projected disc.
  float facing = abs(dot(normalize(vNormalView), normalize(vViewDir)));

  // A halo is light hanging just outside the orb, so the brightest band has
  // to sit where the shell passes closest to the orb's own silhouette, and
  // fall away in both directions.
  //
  // A plain fresnel, pow(1.0 - facing, p), will not do that: it peaks at the
  // shell's own silhouette, which puts a bright ring at the shell's outer
  // edge where the geometry then stops dead. Widening the fade to hide that
  // edge fills the middle in instead, and the halo becomes the solid blob
  // this is trying to avoid. Both failures are visible the moment the orb
  // gets loud.
  //
  // So: a gaussian band in the view angle. Still view-dependent, still
  // rim-weighted, but with the peak placed deliberately rather than wherever
  // the exponent happens to put it.
  float band = (facing - ${GLOW_BAND_CENTER.toFixed(4)}) / uBandWidth;
  float halo = exp(-band * band);

  // Insurance that nothing at all survives at the shell's silhouette, so the
  // outer boundary can never read as an edge.
  halo *= smoothstep(0.0, 0.12, facing);

  float intensity = halo * uStrength;
  gl_FragColor = vec4(uColor * intensity, 1.0);
}
`;

/**
 * Layer 1: the orb.
 *
 * A wireframe icosahedron displaced by three octaves of simplex noise, a
 * back-faced glow shell around it, and three thin rings that only appear while
 * the AI is thinking. Its own 45-degree camera, 4.2 units back.
 */
export class OrbPass implements ScenePass {
  readonly name = 'orb';
  /** Drawn last and on top: the orb is the subject, never occluded. */
  readonly clearDepthBefore = true;

  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly group = new THREE.Group();
  private readonly ringGroup = new THREE.Group();

  private mesh!: THREE.Mesh;
  private geometry!: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;

  private readonly glowMesh: THREE.Mesh;
  private readonly glowGeometry: THREE.IcosahedronGeometry;
  private readonly glowMaterial: THREE.ShaderMaterial;

  private readonly ringMeshes: THREE.Mesh[] = [];
  private readonly ringGeometries: THREE.RingGeometry[] = [];
  private readonly ringMaterials: THREE.MeshBasicMaterial[] = [];

  private tier: PerformanceTier;
  private readonly shape: OrbShape;
  private fillMesh: THREE.Mesh | null = null;
  private fillMaterial: THREE.ShaderMaterial | null = null;
  private readonly pupils = new THREE.Group();
  private readonly pupilDisposables: { dispose(): void }[] = [];
  private readonly trades: TradeBands | null;
  private readonly wickGroup = new THREE.Group();
  private readonly wickGeometries: THREE.BufferGeometry[] = [];
  private spin = 0;

  constructor(tier: PerformanceTier, shape: OrbShape = 'orb', trades = false) {
    this.tier = tier;
    this.shape = shape;
    this.trades = trades ? new TradeBands() : null;

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.camera.position.set(0, 0, 4.2);

    this.material = new THREE.ShaderMaterial({
      vertexShader: ORB_VERTEX,
      fragmentShader: ORB_FRAGMENT,
      uniforms: {
        uTime: { value: 0 },
        uNoiseTime: { value: 0 },
        uActivity: { value: 0 },
        uBass: { value: 0 },
        uAudioActive: { value: 0 },
        // The cat keeps its ears: its outline ripples at half the orb's depth.
        uShapeAmp: { value: shape === 'cat' ? 0.5 : 1 },
        uColor: { value: srgbColor([1, 1, 1]) },
        uColorSecondary: { value: srgbColor([1, 1, 1]) },
        uOpacity: { value: 0.4 },
        uFresnelPower: { value: 2.7 },
        uGlow: { value: 0.35 },
        uTintScale: { value: 3 },
        // How visible the face pointing at us is. The candle reads as a solid body.
        uFloor: { value: shape === 'orb' ? 0.08 : 0.3 },
      },
      wireframe: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    if (shape !== 'orb') {
      this.fillMaterial = new THREE.ShaderMaterial({
        vertexShader: ORB_VERTEX,
        fragmentShader: FILL_FRAGMENT,
        uniforms: this.material.uniforms,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
    }

    this.buildMesh();

    if (shape === 'cat') {
      // Candle pupils, lime left and violet right, as in the logo. They blink.
      const pupil = new THREE.IcosahedronGeometry(1, 3);
      toWickBody(pupil);
      pupil.scale(0.13, 0.13, 0.13);
      const wickLine = new THREE.CylinderGeometry(0.009, 0.009, 0.36, 6, 1, true);
      this.pupilDisposables.push(pupil, wickLine);
      [BRAND.accent, BRAND.secondary].forEach((hex, i) => {
        const material = new THREE.MeshBasicMaterial({
          color: srgbColor(hexToRgb(hex)),
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        });
        this.pupilDisposables.push(material);
        const eye = CAT_EYES[i]!;
        for (const geometry of [pupil, wickLine]) {
          const mesh = new THREE.Mesh(geometry, material);
          mesh.position.set(eye.x, eye.y, CAT_DEPTH * 0.3);
          this.pupils.add(mesh);
        }
      });
      this.group.add(this.pupils);
    }

    if (shape === 'wick') {
      // The wicks share the orb's shader, so they ripple and rim-light with it.
      const { top, bottom, radius } = WICK_LINE;
      const bodyTop = WICK_BODY.b;
      for (const [from, to] of [
        [bodyTop * 0.9, top],
        [bottom, -bodyTop * 0.9],
      ] as const) {
        const height = to - from;
        const geometry = new THREE.CylinderGeometry(radius, radius, height, 6, Math.max(4, Math.round(height * 14)), true);
        geometry.translate(0, from + height / 2, 0);
        this.wickGeometries.push(geometry);
        this.wickGroup.add(new THREE.Mesh(geometry, this.material));
      }
      this.group.add(this.wickGroup);
    }

    this.glowGeometry = new THREE.IcosahedronGeometry(1.3, 5);
    this.glowMaterial = new THREE.ShaderMaterial({
      vertexShader: GLOW_VERTEX,
      fragmentShader: GLOW_FRAGMENT,
      uniforms: {
        uColor: { value: srgbColor([1, 1, 1]) },
        uStrength: { value: 0.035 },
        uBandWidth: { value: 0.3 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
    });
    this.glowMesh = new THREE.Mesh(this.glowGeometry, this.glowMaterial);
    // Stretch the halo to the candle's height so it still hugs the edge.
    if (shape === 'wick') this.glowMesh.scale.set(0.62, 1.15, 0.62);
    if (shape === 'cat') this.glowMesh.scale.setScalar(0.95);
    this.group.add(this.glowMesh);

    for (const ring of RINGS) {
      const geometry = new THREE.RingGeometry(ring.radius - 0.004, ring.radius + 0.004, 160);
      const material = new THREE.MeshBasicMaterial({
        color: srgbColor([1, 1, 1]),
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.rotation.set(ring.tiltX, ring.tiltY, 0);
      this.ringGeometries.push(geometry);
      this.ringMaterials.push(material);
      this.ringMeshes.push(mesh);
      this.ringGroup.add(mesh);
    }

    this.group.add(this.ringGroup);
    this.scene.add(this.group);
    if (this.trades) this.scene.add(this.trades.group);
  }

  private buildMesh(): void {
    if (this.shape === 'cat') {
      this.geometry = buildCatGeometry(this.tier === 'high' ? 0.05 : 0.085);
    } else {
      this.geometry = new THREE.IcosahedronGeometry(1, ORB_DETAIL[this.tier]);
      if (this.shape === 'wick') toWickBody(this.geometry);
    }
    if (this.fillMaterial) {
      if (this.fillMesh) this.group.remove(this.fillMesh);
      this.fillMesh = new THREE.Mesh(this.geometry, this.fillMaterial);
      this.fillMesh.renderOrder = -1;
      this.group.add(this.fillMesh);
    }
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.group.add(this.mesh);
  }

  update(ctx: FrameContext): void {
    const { params, audio, color } = ctx;

    const u = this.material.uniforms;
    u.uTime!.value = ctx.animTime;
    u.uNoiseTime!.value = ctx.noiseTime;
    u.uActivity!.value = ctx.activity;
    u.uBass!.value = audio.bass;
    u.uAudioActive!.value = ctx.audioActive;
    setSrgb(u.uColor!.value as THREE.Color, color);
    setSrgb(u.uColorSecondary!.value as THREE.Color, params.colorSecondary);
    u.uOpacity!.value = params.opacity;
    u.uFresnelPower!.value = params.fresnelPower;
    u.uGlow!.value = params.glow;

    const g = this.glowMaterial.uniforms;
    setSrgb(g.uColor!.value as THREE.Color, color);
    // The halo answers the voice, but at a fraction of the orb's response so
    // it stays a halo rather than washing the screen.
    g.uStrength!.value = params.glow * (0.10 + audio.level * 0.16 + audio.bass * 0.07);
    // The stretched halo covers more screen around the candle, so it runs softer.
    if (this.shape !== 'orb') g.uStrength!.value *= 0.55;
    // A sharper orb edge gets a tighter halo, so the two read as one object.
    g.uBandWidth!.value = 0.42 / Math.max(1.2, params.fresnelPower * 0.55);

    for (let i = 0; i < this.ringMeshes.length; i += 1) {
      const material = this.ringMaterials[i]!;
      material.opacity = params.ringOpacity * 0.9;
      material.visible = params.ringOpacity > 0.002;
      setSrgb(material.color, color);
      this.ringMeshes[i]!.rotation.z += RINGS[i]!.speed * ctx.dt;
    }

    this.spin += params.rotationSpeed * ctx.dt;
    this.group.rotation.y = this.spin;
    this.trades?.update(ctx.dt, clamp01(audio.level * params.networkGain));

    const scale = 1 + audio.level * 0.07 + audio.bass * 0.04;
    if (this.shape === 'cat') {
      // A face looks at you: it sways and turns its head, it never spins round.
      this.group.rotation.y = Math.sin(this.spin * 1.3) * 0.38;
      this.group.rotation.x = Math.sin(ctx.animTime * 0.13) * 0.08;
      this.group.rotation.z = Math.sin(ctx.animTime * 0.19) * 0.03;
      this.group.scale.setScalar(scale);
      // A blink every few seconds: the candle pupils squeeze shut and reopen.
      const cycle = ctx.animTime % 5.3;
      const blink = cycle < 0.16 ? Math.abs(Math.cos((cycle / 0.16) * Math.PI)) : 1;
      const open = Math.max(0.08, blink) * (1 + audio.level * 0.25);
      for (const pupil of this.pupils.children) pupil.scale.set(1, open, 1);
    } else if (this.shape === 'wick') {
      // A candle stays upright: only a slight sway. The body grows with the
      // voice the way a candle prints while price moves.
      this.group.rotation.x = Math.sin(ctx.animTime * 0.11) * 0.06;
      this.group.rotation.z = Math.sin(ctx.animTime * 0.17) * 0.04;
      this.group.scale.setScalar(scale * WICK_SCALE);
      this.mesh.scale.set(1, 1 + audio.level * 0.22 + audio.bass * 0.08, 1);
    } else {
      this.group.rotation.x = Math.sin(ctx.animTime * 0.11) * 0.22;
      this.group.scale.setScalar(scale);
    }
  }

  render(renderer: THREE.WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }

  resize(width: number, height: number): void {
    this.camera.aspect = height > 0 ? width / height : 1;
    this.camera.updateProjectionMatrix();
  }

  setTier(tier: PerformanceTier): void {
    if (tier === this.tier) return;
    this.tier = tier;
    this.group.remove(this.mesh);
    this.geometry.dispose();
    this.buildMesh();
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.glowGeometry.dispose();
    this.glowMaterial.dispose();
    for (const geometry of this.wickGeometries) geometry.dispose();
    for (const d of this.pupilDisposables) d.dispose();
    this.fillMaterial?.dispose();
    this.trades?.dispose();
    for (const geometry of this.ringGeometries) geometry.dispose();
    for (const material of this.ringMaterials) material.dispose();
    this.scene.clear();
  }
}
