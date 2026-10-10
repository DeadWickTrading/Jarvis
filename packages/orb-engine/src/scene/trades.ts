import * as THREE from 'three';
import { BRAND, hexToRgb } from '../brand.js';
import { srgbColor } from './color.js';

/** Three tilted bands of trades orbiting the subject: tilt x, tilt y, spin rate. */
const BANDS = [
  { tiltX: 1.2, tiltY: 0.2, speed: 0.11 },
  { tiltX: 0.45, tiltY: -0.6, speed: -0.08 },
  { tiltX: -0.7, tiltY: 0.9, speed: 0.06 },
] as const;
const PER_BAND = 22;
/** Two trades closer than this are joined into a constellation. */
const LINK_DISTANCE = 0.8;

/** Deterministic 0..1 sequence, so the tape is the same every load. */
function rng(seed: number): () => number {
  let s = seed % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/**
 * Big trades as cubes: lime buys, red sells, sized with a heavy tail (mostly
 * small prints, a few blocks). Each band turns on its own axis and keeps its
 * links, so the constellations travel round the subject intact.
 */
export class TradeBands {
  readonly group = new THREE.Group();
  private readonly bands: THREE.Group[] = [];
  private readonly fills: THREE.MeshBasicMaterial[] = [];
  private readonly edges: THREE.LineBasicMaterial[] = [];
  private readonly linkMaterial: THREE.LineBasicMaterial;
  private readonly disposables: { dispose(): void }[] = [];
  private readonly spinners: { mesh: THREE.Object3D; rate: number }[] = [];

  constructor(seed = 7) {
    const rand = rng(seed);
    const buy = srgbColor(hexToRgb(BRAND.accent));
    const sell = srgbColor(hexToRgb(BRAND.error));
    this.linkMaterial = new THREE.LineBasicMaterial({
      color: srgbColor(hexToRgb(BRAND.secondary)),
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.disposables.push(this.linkMaterial);

    for (const spec of BANDS) {
      const band = new THREE.Group();
      band.rotation.set(spec.tiltX, spec.tiltY, 0);
      const points: THREE.Vector3[] = [];
      for (let i = 0; i < PER_BAND; i += 1) {
        const angle = rand() * Math.PI * 2;
        const radius = 1.75 + rand() * 0.75;
        const size = 0.035 + 0.17 * rand() ** 4;
        const colour = rand() < 0.55 ? buy : sell;
        const at = new THREE.Vector3(Math.cos(angle) * radius, (rand() - 0.5) * 0.3, Math.sin(angle) * radius);
        points.push(at);

        const box = new THREE.BoxGeometry(size, size, size);
        const outline = new THREE.EdgesGeometry(box);
        const fill = new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.85, depthWrite: false });
        const edge = new THREE.LineBasicMaterial({
          color: colour.clone().multiplyScalar(1.4),
          transparent: true,
          opacity: 1,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        });
        const cube = new THREE.Group();
        cube.add(new THREE.Mesh(box, fill));
        const frame = new THREE.LineSegments(outline, edge);
        frame.scale.setScalar(1.4);
        cube.add(frame);
        cube.position.copy(at);
        cube.rotation.set(rand() * 3, rand() * 3, 0);
        band.add(cube);
        this.spinners.push({ mesh: cube, rate: (rand() - 0.5) * 0.8 });
        this.fills.push(fill);
        this.edges.push(edge);
        this.disposables.push(box, outline, fill, edge);
      }
      const segments: THREE.Vector3[] = [];
      for (let a = 0; a < points.length; a += 1) {
        for (let b = a + 1; b < points.length; b += 1) {
          if (points[a]!.distanceTo(points[b]!) < LINK_DISTANCE) segments.push(points[a]!, points[b]!);
        }
      }
      const linkGeometry = new THREE.BufferGeometry().setFromPoints(segments);
      band.add(new THREE.LineSegments(linkGeometry, this.linkMaterial));
      this.disposables.push(linkGeometry);
      this.bands.push(band);
      this.group.add(band);
    }
  }

  /** Turn the bands; the voice speeds them up and lights the links. */
  update(dt: number, response: number): void {
    const speed = 1 + response * 2.5;
    this.bands.forEach((band, i) => band.rotateY(BANDS[i]!.speed * speed * dt));
    for (const s of this.spinners) s.mesh.rotation.y += s.rate * dt;
    this.linkMaterial.opacity = 0.22 + response * 0.45;
    for (const f of this.fills) f.opacity = 0.7 + response * 0.3;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
