import { describe, expect, it } from 'vitest';
import { BRAND, CLUSTER_HUES, hexToRgb } from '../src/brand.js';
import { buildGalaxy, DEFAULT_GALAXY, linkNodes, thinGalaxy } from '../src/layout.js';
import type { GalaxyNode } from '../src/layout.js';

const lengthOf = (p: readonly [number, number, number]) => Math.hypot(p[0], p[1], p[2]);

describe('buildGalaxy', () => {
  it('is identical for the same seed', () => {
    const a = buildGalaxy({ seed: 7 });
    const b = buildGalaxy({ seed: 7 });
    expect(a.nodes).toEqual(b.nodes);
    expect(a.links).toEqual(b.links);
    expect([...a.dust]).toEqual([...b.dust]);
  });

  it('is a different galaxy for a different seed', () => {
    const a = buildGalaxy({ seed: 1 });
    const b = buildGalaxy({ seed: 2 });
    expect(a.nodes[0]!.position).not.toEqual(b.nodes[0]!.position);
  });

  it('produces about the requested number of nodes', () => {
    const galaxy = buildGalaxy();
    expect(galaxy.nodes.length).toBe(DEFAULT_GALAXY.nodeCount);
  });

  it('scatters eight clusters, each with six to eight members', () => {
    const galaxy = buildGalaxy();
    const byCluster = new Map<number, GalaxyNode[]>();
    for (const node of galaxy.nodes) {
      if (node.cluster < 0) continue;
      const list = byCluster.get(node.cluster) ?? [];
      list.push(node);
      byCluster.set(node.cluster, list);
    }
    expect(byCluster.size).toBe(8);
    for (const [cluster, members] of byCluster) {
      expect(members.length, `cluster ${cluster}`).toBeGreaterThanOrEqual(6);
      expect(members.length, `cluster ${cluster}`).toBeLessThanOrEqual(8);
    }
  });

  it('places cluster centres on a shell between 13 and 25 units out', () => {
    const galaxy = buildGalaxy();
    const centres = new Map<number, [number, number, number]>();
    const counts = new Map<number, number>();
    for (const node of galaxy.nodes) {
      if (node.cluster < 0) continue;
      const sum = centres.get(node.cluster) ?? [0, 0, 0];
      sum[0] += node.position[0];
      sum[1] += node.position[1];
      sum[2] += node.position[2];
      centres.set(node.cluster, sum);
      counts.set(node.cluster, (counts.get(node.cluster) ?? 0) + 1);
    }
    for (const [cluster, sum] of centres) {
      const n = counts.get(cluster)!;
      const radius = lengthOf([sum[0] / n, sum[1] / n, sum[2] / n]);
      // The centroid of the members sits near the cluster centre, within the
      // scatter radius either way.
      expect(radius, `cluster ${cluster}`).toBeGreaterThan(9);
      expect(radius, `cluster ${cluster}`).toBeLessThan(29);
    }
  });

  it('keeps cluster members within a few units of each other', () => {
    const galaxy = buildGalaxy();
    for (let c = 0; c < 8; c += 1) {
      const members = galaxy.nodes.filter((n) => n.cluster === c);
      for (const a of members) {
        for (const b of members) {
          expect(lengthOf([
            a.position[0] - b.position[0],
            a.position[1] - b.position[1],
            a.position[2] - b.position[2],
          ])).toBeLessThanOrEqual(2 * 3.6 + 1e-9);
        }
      }
    }
  });

  it('gives each cluster its own hue and strays a muted blue-grey', () => {
    const galaxy = buildGalaxy();
    const dim = hexToRgb(BRAND.dim);
    for (const node of galaxy.nodes) {
      if (node.cluster < 0) {
        expect(node.color).toEqual(dim);
        continue;
      }
      // Members sit between their cluster's hue and the muted grey.
      const hue = hexToRgb(CLUSTER_HUES[node.cluster]!);
      for (let i = 0; i < 3; i += 1) {
        const lo = Math.min(hue[i]!, dim[i]!) - 1e-9;
        const hi = Math.max(hue[i]!, dim[i]!) + 1e-9;
        expect(node.color[i]).toBeGreaterThanOrEqual(lo);
        expect(node.color[i]).toBeLessThanOrEqual(hi);
      }
    }
  });

  it('puts dust on a much larger shell than the nodes', () => {
    const galaxy = buildGalaxy();
    const nodeMax = Math.max(...galaxy.nodes.map((n) => lengthOf(n.position)));
    for (let i = 0; i < galaxy.dust.length; i += 3) {
      const radius = Math.hypot(galaxy.dust[i]!, galaxy.dust[i + 1]!, galaxy.dust[i + 2]!);
      expect(radius).toBeGreaterThan(nodeMax);
    }
    expect(galaxy.dust.length / 3).toBe(DEFAULT_GALAXY.dustCount);
  });
});

describe('links', () => {
  it('joins exactly the pairs closer than the threshold', () => {
    const nodes = [
      { position: [0, 0, 0], color: [1, 1, 1], cluster: 0, size: 1 },
      { position: [5, 0, 0], color: [1, 1, 1], cluster: 0, size: 1 },
      { position: [50, 0, 0], color: [1, 1, 1], cluster: 1, size: 1 },
    ] as const satisfies readonly GalaxyNode[];

    const links = linkNodes(nodes, 10);
    expect(links).toHaveLength(1);
    expect(links[0]!.a).toBe(0);
    expect(links[0]!.b).toBe(1);
    expect(links[0]!.distance).toBeCloseTo(5, 12);
  });

  it('never links a node to itself or duplicates a pair', () => {
    const galaxy = buildGalaxy();
    const seen = new Set<string>();
    for (const link of galaxy.links) {
      expect(link.a).not.toBe(link.b);
      const key = `${Math.min(link.a, link.b)}-${Math.max(link.a, link.b)}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('honours the distance threshold', () => {
    const galaxy = buildGalaxy();
    for (const link of galaxy.links) {
      expect(link.distance).toBeLessThanOrEqual(DEFAULT_GALAXY.linkDistance + 1e-9);
    }
  });

  it('builds constellations inside clusters and some bridges between them', () => {
    const galaxy = buildGalaxy();
    const within = galaxy.links.filter(
      (l) =>
        galaxy.nodes[l.a]!.cluster >= 0 && galaxy.nodes[l.a]!.cluster === galaxy.nodes[l.b]!.cluster,
    );
    const between = galaxy.links.filter(
      (l) => galaxy.nodes[l.a]!.cluster !== galaxy.nodes[l.b]!.cluster,
    );
    // Every cluster should be internally well connected...
    expect(within.length).toBeGreaterThan(100);
    // ...and there should be some bridges, but not a hairball.
    expect(between.length).toBeGreaterThan(0);
    expect(galaxy.links.length).toBeLessThan(galaxy.nodes.length * 8);
  });

  it('colours a link from its two endpoints', () => {
    const galaxy = buildGalaxy();
    for (const link of galaxy.links.slice(0, 50)) {
      const a = galaxy.nodes[link.a]!.color;
      const b = galaxy.nodes[link.b]!.color;
      for (let i = 0; i < 3; i += 1) {
        expect(link.color[i]).toBeCloseTo((a[i]! + b[i]!) / 2, 10);
      }
    }
  });
});

describe('thinGalaxy', () => {
  it('is the same galaxy with fewer points, not a different one', () => {
    const full = buildGalaxy();
    const thin = thinGalaxy(full, 0.55);

    expect(thin.nodes.length).toBeLessThan(full.nodes.length);
    // Every surviving node is exactly where it was in the full layout.
    for (let i = 0; i < thin.nodes.length; i += 1) {
      expect(thin.nodes[i]).toEqual(full.nodes[i]);
    }
  });

  it('keeps every cluster represented rather than deleting whole clusters', () => {
    const full = buildGalaxy();
    const thin = thinGalaxy(full, 0.5);
    const clusters = new Set(thin.nodes.filter((n) => n.cluster >= 0).map((n) => n.cluster));
    expect(clusters.size).toBe(8);
    // Strays survive too, so the sky does not become only clusters.
    expect(thin.nodes.some((n) => n.cluster === -1)).toBe(true);
  });

  it('drops links whose endpoints are gone and keeps the rest intact', () => {
    const full = buildGalaxy();
    const thin = thinGalaxy(full, 0.4);
    for (const link of thin.links) {
      expect(link.a).toBeLessThan(thin.nodes.length);
      expect(link.b).toBeLessThan(thin.nodes.length);
      // The link still refers to the same pair it did before thinning.
      expect(full.nodes[link.a]).toEqual(thin.nodes[link.a]);
      expect(full.nodes[link.b]).toEqual(thin.nodes[link.b]);
    }
    expect(thin.links.length).toBeLessThan(full.links.length);
  });

  it('thins the dust too', () => {
    const full = buildGalaxy();
    const thin = thinGalaxy(full, 0.5);
    expect(thin.dust.length).toBeLessThan(full.dust.length);
    for (let i = 0; i < thin.dust.length; i += 1) {
      expect(thin.dust[i]).toBe(full.dust[i]);
    }
  });

  it('is a no-op at or above full strength, and never empties the galaxy', () => {
    const full = buildGalaxy();
    expect(thinGalaxy(full, 1)).toBe(full);
    expect(thinGalaxy(full, 5)).toBe(full);
    expect(thinGalaxy(full, 0).nodes.length).toBeGreaterThanOrEqual(1);
    expect(thinGalaxy(full, -1).nodes.length).toBeGreaterThanOrEqual(1);
  });
});
