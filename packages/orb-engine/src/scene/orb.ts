import * as THREE from 'three';
import { SIMPLEX_3D } from '../shaders/noise.js';
import { setSrgb, srgbColor } from './color.js';
import type { PerformanceTier } from '../types.js';
import type { FrameContext, ScenePass } from './pass.js';

/** Icosahedron subdivision per tier. 24 reads as a fine mesh; 10 still reads. */
const ORB_DETAIL: Record<PerformanceTier, number> = { high: 24, low: 10 };

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
  float displacement = noiseSum * uActivity;

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
  float strength = uOpacity * (0.08 + 0.92 * fresnel) * (0.55 + uGlow * 0.75);

  // Additive blending multiplies the source by its own alpha, so anything put
  // in the alpha channel would be applied twice. The magnitude belongs in the
  // colour; alpha stays at 1.
  gl_FragColor = vec4(tinted * strength, 1.0);
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

const GLOW_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uStrength;
uniform float uPower;

varying vec3 vNormalView;
varying vec3 vViewDir;

void main() {
  // Rendered back-faces-only, so this shades the far hemisphere. At the
  // silhouette the normal is perpendicular to the view and this goes to 1; at
  // the centre of the disc it points straight away and this goes to 0.
  //
  // That direction matters: inverted, the shell fills in as a solid blob the
  // moment the orb gets loud, instead of reading as a halo around it.
  float facing = abs(dot(normalize(vNormalView), normalize(vViewDir)));
  float rim = pow(1.0 - facing, uPower);

  // The shell's own silhouette is a hard geometric edge. Fading the last
  // sliver out turns what would be a cut-off ring into a halo that dissolves
  // into the sky, and it keeps the brightest band just outside the orb rather
  // than at the shell's rim.
  float soften = smoothstep(0.0, 0.3, facing);

  float intensity = rim * soften * uStrength;
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
  private geometry!: THREE.IcosahedronGeometry;
  private readonly material: THREE.ShaderMaterial;

  private readonly glowMesh: THREE.Mesh;
  private readonly glowGeometry: THREE.IcosahedronGeometry;
  private readonly glowMaterial: THREE.ShaderMaterial;

  private readonly ringMeshes: THREE.Mesh[] = [];
  private readonly ringGeometries: THREE.RingGeometry[] = [];
  private readonly ringMaterials: THREE.MeshBasicMaterial[] = [];

  private tier: PerformanceTier;
  private spin = 0;

  constructor(tier: PerformanceTier) {
    this.tier = tier;

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
        uColor: { value: srgbColor([1, 1, 1]) },
        uColorSecondary: { value: srgbColor([1, 1, 1]) },
        uOpacity: { value: 0.4 },
        uFresnelPower: { value: 2.7 },
        uGlow: { value: 0.35 },
        uTintScale: { value: 3 },
      },
      wireframe: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.buildMesh();

    this.glowGeometry = new THREE.IcosahedronGeometry(1.3, 5);
    this.glowMaterial = new THREE.ShaderMaterial({
      vertexShader: GLOW_VERTEX,
      fragmentShader: GLOW_FRAGMENT,
      uniforms: {
        uColor: { value: srgbColor([1, 1, 1]) },
        uStrength: { value: 0.35 },
        uPower: { value: 2.6 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
    });
    this.glowMesh = new THREE.Mesh(this.glowGeometry, this.glowMaterial);
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
  }

  private buildMesh(): void {
    this.geometry = new THREE.IcosahedronGeometry(1, ORB_DETAIL[this.tier]);
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
    g.uStrength!.value = params.glow * (0.55 + audio.level * 0.85 + audio.bass * 0.35);
    g.uPower!.value = Math.max(1.2, params.fresnelPower * 0.95);

    for (let i = 0; i < this.ringMeshes.length; i += 1) {
      const material = this.ringMaterials[i]!;
      material.opacity = params.ringOpacity * 0.9;
      material.visible = params.ringOpacity > 0.002;
      setSrgb(material.color, color);
      this.ringMeshes[i]!.rotation.z += RINGS[i]!.speed * ctx.dt;
    }

    this.spin += params.rotationSpeed * ctx.dt;
    this.group.rotation.y = this.spin;
    this.group.rotation.x = Math.sin(ctx.animTime * 0.11) * 0.22;

    const scale = 1 + audio.level * 0.07 + audio.bass * 0.04;
    this.group.scale.setScalar(scale);
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
    for (const geometry of this.ringGeometries) geometry.dispose();
    for (const material of this.ringMaterials) material.dispose();
    this.scene.clear();
  }
}
