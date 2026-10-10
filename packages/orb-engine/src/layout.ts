import { CLUSTER_HUES, BRAND, hexToRgb, mixRgb } from './brand.js';
import type { Rgb } from './brand.js';
import { createRng } from './random.js';

/** One glowing point in the network. */
export interface GalaxyNode {
  readonly position: readonly [number, number, number];
  readonly color: Rgb;
  /** Index of the cluster this belongs to, or -1 for a stray node. */
  readonly cluster: number;
  /** Relative sprite size. */
  readonly size: number;
}

/** A faint line between two nodes that happen to be near each other. */
export interface GalaxyLink {
  readonly a: number;
  readonly b: number;
  readonly color: Rgb;
  readonly distance: number;
}

export interface Galaxy {
  readonly seed: number;
  readonly nodes: readonly GalaxyNode[];
  readonly links: readonly GalaxyLink[];
  /** Flat xyz triples for the dust field. */
  readonly dust: Float32Array;
}

export interface GalaxyOptions {
  readonly seed?: number;
  /** How many clusters to scatter. One hue each. */
  readonly clusterCount?: number;
  /** Total nodes, clusters and strays together. */
  readonly nodeCount?: number;
  /** Nodes closer than this are joined by a line. */
  readonly linkDistance?: number;
  readonly dustCount?: number;
}

export const DEFAULT_GALAXY: Required<GalaxyOptions> = {
  seed: 20_251_010,
  clusterCount: 8,
  nodeCount: 100,
  linkDistance: 10,
  dustCount: 320,
};

/** Cluster centres sit on a shell this far from the middle. */
const CLUSTER_SHELL = { min: 13, max: 25 } as const;
/** Nodes scatter this far from their cluster's centre. */
const CLUSTER_SPREAD = { min: 0.6, max: 3.6 } as const;
/** Nodes per cluster. */
const CLUSTER_SIZE = { min: 6, max: 8 } as const;
/** Stray nodes fill a wider shell than the clusters do. */
const STRAY_SHELL = { min: 9, max: 29 } as const;
/** Dust sits well outside everything else. */
const DUST_SHELL = { min: 34, max: 64 } as const;

/**
 * Build the network.
 *
 * Deterministic for a seed: the same seed always produces the same galaxy, so
 * screenshots are comparable between runs and a visual regression means
 * something changed in the code rather than in the dice.
 *
 * Nodes are emitted round-robin across the clusters and the stray group
 * rather than cluster by cluster. That ordering is what makes
 * {@link thinGalaxy} work: taking a prefix then drops the last node or two
 * from every cluster evenly, leaving the same galaxy with fewer points,
 * instead of deleting whole clusters from one side of the sky.
 */
export function buildGalaxy(options: GalaxyOptions = {}): Galaxy {
  const config = { ...DEFAULT_GALAXY, ...options };
  const rng = createRng(config.seed);
  const stray = hexToRgb(BRAND.dim);

  // --- cluster centres and their members ----------------------------------
  const groups: GalaxyNode[][] = [];

  for (let c = 0; c < config.clusterCount; c += 1) {
    const [ux, uy, uz] = rng.onSphere();
    const radius = rng.range(CLUSTER_SHELL.min, CLUSTER_SHELL.max);
    const centre: [number, number, number] = [ux * radius, uy * radius, uz * radius];
    const hue = hexToRgb(CLUSTER_HUES[c % CLUSTER_HUES.length]!);

    const members: GalaxyNode[] = [];
    const count = rng.int(CLUSTER_SIZE.min, CLUSTER_SIZE.max);
    for (let i = 0; i < count; i += 1) {
      const [dx, dy, dz] = rng.onSphere();
      const spread = rng.range(CLUSTER_SPREAD.min, CLUSTER_SPREAD.max);
      members.push({
        position: [centre[0] + dx * spread, centre[1] + dy * spread, centre[2] + dz * spread],
        // Vary each node slightly around its cluster's hue so a cluster reads
        // as a family of lights rather than one colour stamped eight times.
        color: mixRgb(hue, stray, rng.range(0, 0.22)),
        cluster: c,
        size: rng.range(0.8, 1.45),
      });
    }
    groups.push(members);
  }

  // --- stray nodes ---------------------------------------------------------
  const clustered = groups.reduce((sum, g) => sum + g.length, 0);
  const strayCount = Math.max(0, config.nodeCount - clustered);
  const strays: GalaxyNode[] = [];
  for (let i = 0; i < strayCount; i += 1) {
    const [ux, uy, uz] = rng.onSphere();
    const radius = rng.range(STRAY_SHELL.min, STRAY_SHELL.max);
    strays.push({
      position: [ux * radius, uy * radius, uz * radius],
      color: stray,
      cluster: -1,
      size: rng.range(0.45, 0.8),
    });
  }
  groups.push(strays);

  // --- interleave ----------------------------------------------------------
  const nodes: GalaxyNode[] = [];
  const longest = Math.max(...groups.map((g) => g.length));
  for (let i = 0; i < longest; i += 1) {
    for (const group of groups) {
      const node = group[i];
      if (node) nodes.push(node);
    }
  }

  // --- dust ----------------------------------------------------------------
  const dust = new Float32Array(config.dustCount * 3);
  for (let i = 0; i < config.dustCount; i += 1) {
    const [ux, uy, uz] = rng.onSphere();
    const radius = rng.range(DUST_SHELL.min, DUST_SHELL.max);
    dust[i * 3] = ux * radius;
    dust[i * 3 + 1] = uy * radius;
    dust[i * 3 + 2] = uz * radius;
  }

  return { seed: config.seed, nodes, links: linkNodes(nodes, config.linkDistance), dust };
}

/**
 * Join every pair of nodes closer than `maxDistance`.
 *
 * Quadratic, which for a hundred nodes is five thousand comparisons once at
 * startup — not worth a spatial index.
 */
export function linkNodes(nodes: readonly GalaxyNode[], maxDistance: number): GalaxyLink[] {
  const links: GalaxyLink[] = [];
  const maxSquared = maxDistance * maxDistance;

  for (let a = 0; a < nodes.length; a += 1) {
    const pa = nodes[a]!.position;
    for (let b = a + 1; b < nodes.length; b += 1) {
      const pb = nodes[b]!.position;
      const dx = pa[0] - pb[0];
      const dy = pa[1] - pb[1];
      const dz = pa[2] - pb[2];
      const squared = dx * dx + dy * dy + dz * dz;
      if (squared > maxSquared) continue;
      links.push({
        a,
        b,
        color: mixRgb(nodes[a]!.color, nodes[b]!.color, 0.5),
        distance: Math.sqrt(squared),
      });
    }
  }
  return links;
}

/**
 * Return the same galaxy with fewer points, for the cheaper rendering tier.
 *
 * Because nodes are stored round-robin across the groups, a prefix is a
 * thinned version of every cluster rather than a subset of the clusters: the
 * constellation keeps its shape and its colour balance, it just gets sparser.
 */
export function thinGalaxy(galaxy: Galaxy, keepFraction: number): Galaxy {
  const keep = Math.max(1, Math.round(galaxy.nodes.length * Math.min(1, Math.max(0, keepFraction))));
  if (keep >= galaxy.nodes.length) return galaxy;

  const nodes = galaxy.nodes.slice(0, keep);
  const dustKeep = Math.max(0, Math.round((galaxy.dust.length / 3) * keepFraction)) * 3;

  return {
    seed: galaxy.seed,
    nodes,
    // Node indices are preserved by taking a prefix, so surviving links keep
    // pointing at the right nodes.
    links: galaxy.links.filter((link) => link.a < keep && link.b < keep),
    dust: galaxy.dust.subarray(0, dustKeep),
  };
}
