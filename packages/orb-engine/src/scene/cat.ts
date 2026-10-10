import * as THREE from 'three';
import { TessellateModifier } from 'three/addons/modifiers/TessellateModifier.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * "The Head": the Deadwick cat silhouette, in the same 120 x 120 design box
 * as the DL Brand Banner indicator, so the two always match.
 */
const HEAD = [
  18, 104, 12, 88, 11, 70, 13, 56, 18, 44, 14, 8, 44, 30, 54, 28, 66, 28, 76, 30, 106, 8, 102, 44, 107, 56,
  109, 70, 108, 88, 102, 104, 90, 110, 60, 113, 30, 110,
] as const;

/** Design units to scene units: about 1.8 tall, centred. */
const K = 1 / 62;
const X = (v: number): number => (v - 60) * K;
const Y = (v: number): number => -(v - 62) * K;

/** Eye centres (design box) and radii. The pupils sit in the holes. */
export const CAT_EYES = [
  { x: X(49), y: Y(75.5) },
  { x: X(85), y: Y(75.5) },
] as const;
const EYE_RX = 11 * K;
const EYE_RY = 9.5 * K;
/** Half the head's thickness. */
export const CAT_DEPTH = 0.2;

/**
 * Build the head as a closed, evenly meshed solid: extruded with a bevel,
 * eye and nose holes cut through, then tessellated so every triangle is
 * small. Vertices are merged and normals smoothed, so the noise displacement
 * ripples the whole head without cracking at its edges.
 */
export function buildCatGeometry(maxEdge: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  for (let i = 0; i < HEAD.length; i += 2) {
    const x = X(HEAD[i]!);
    const y = Y(HEAD[i + 1]!);
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  for (const eye of CAT_EYES) {
    const hole = new THREE.Path();
    hole.absellipse(eye.x, eye.y, EYE_RX, EYE_RY, 0, Math.PI * 2, true, 0);
    shape.holes.push(hole);
  }
  const nose = new THREE.Path();
  nose.moveTo(X(60), Y(87));
  nose.lineTo(X(65), Y(93));
  nose.lineTo(X(55), Y(93));
  nose.lineTo(X(60), Y(87));
  shape.holes.push(nose);

  const extruded = new THREE.ExtrudeGeometry(shape, {
    depth: CAT_DEPTH * 2 - 0.1,
    bevelEnabled: true,
    bevelThickness: 0.05,
    bevelSize: 0.035,
    bevelSegments: 2,
    curveSegments: 20,
    steps: 2,
  });
  extruded.translate(0, 0, -(CAT_DEPTH - 0.05));

  const tessellated = new TessellateModifier(maxEdge, 8).modify(extruded);
  extruded.dispose();
  tessellated.deleteAttribute('normal');
  tessellated.deleteAttribute('uv');
  const merged = mergeVertices(tessellated, 1e-4);
  tessellated.dispose();
  merged.computeVertexNormals();
  return merged;
}
