/**
 * Personalized PageRank (PPR) — given a source node, returns the most
 * relevant other nodes by random-walk-with-restart, treating the
 * indexer's edges as undirected.
 *
 * Used by the entity-detail page's graph view (ADR-076) to pick which
 * neighbors to surface around the focal node.
 *
 * For the meta-Doco's ~130-entity scale, this runs in well under
 * 100ms with default iters. Iterates until rank deltas drop below a
 * tolerance; capped at iters.
 */

export interface PprEdge {
  from: string;
  to: string;
  /** Optional edge type; lets `edgeWeight` boost specific kinds (e.g. `in_scope_of`). */
  edge_type?: string;
}

export interface PprNeighbor {
  id: string;
  score: number;
}

export interface PprOptions {
  /** Damping factor — probability the random walker continues vs. teleports back to source. Standard 0.85. */
  alpha?: number;
  /** Hard cap on iterations; default 50 (converges much earlier in practice). */
  iters?: number;
  /** Maximum number of neighbors to return. */
  topK?: number;
  /** Convergence tolerance on max rank delta; default 1e-6. */
  tol?: number;
  /**
   * Weight per edge type. Default returns 1 for every type. Higher weight =
   * more random-walker mass flows along that edge. Per ADR-079, weighting
   * `in_scope_of` higher pulls scope-shared neighbors closer in the ranking.
   */
  edgeWeight?: (edge_type: string | undefined) => number;
}

export function personalizedPageRank(
  edges: PprEdge[],
  sourceId: string,
  options: PprOptions = {},
): PprNeighbor[] {
  const alpha = options.alpha ?? 0.85;
  const iters = options.iters ?? 50;
  const topK = options.topK ?? 30;
  const tol = options.tol ?? 1e-6;
  const edgeWeight = options.edgeWeight ?? (() => 1);

  // Build node index. Walk every edge endpoint plus the source.
  const idToIdx = new Map<string, number>();
  function idx(id: string): number {
    let i = idToIdx.get(id);
    if (i === undefined) {
      i = idToIdx.size;
      idToIdx.set(id, i);
    }
    return i;
  }
  idx(sourceId);
  for (const e of edges) {
    idx(e.from);
    idx(e.to);
  }
  const n = idToIdx.size;
  const idxToId: string[] = new Array(n);
  for (const [id, i] of idToIdx) idxToId[i] = id;
  const sourceIdx = idToIdx.get(sourceId)!;

  // Build undirected weighted adjacency (in semantic terms, "A → B" and
  // "B referenced by A" are equally informative for relevance — distinguishing
  // them in PPR would weight the central node toward only its outbound edges,
  // which is wrong for context discovery).
  // Per-edge weight via options.edgeWeight (default 1.0). Out-degree becomes
  // the sum of incident weights.
  const neighbors: { idx: number; w: number }[][] = Array.from({ length: n }, () => []);
  for (const e of edges) {
    const a = idToIdx.get(e.from)!;
    const b = idToIdx.get(e.to)!;
    if (a === b) continue; // self-edges add nothing
    const w = edgeWeight(e.edge_type);
    if (w <= 0) continue;
    neighbors[a]!.push({ idx: b, w });
    neighbors[b]!.push({ idx: a, w });
  }

  // Personalization: 1 at source, 0 elsewhere. The "restart" target.
  const personalization = new Float64Array(n);
  personalization[sourceIdx] = 1;

  // Initial rank: concentrated at source.
  let rank = new Float64Array(n);
  rank[sourceIdx] = 1;

  for (let it = 0; it < iters; it++) {
    const next = new Float64Array(n);
    let dangling = 0;

    for (let u = 0; u < n; u++) {
      const out = neighbors[u]!;
      if (out.length === 0) {
        dangling += rank[u]!;
        continue;
      }
      // Weighted: distribute mass proportional to each outgoing edge's weight.
      let totalW = 0;
      for (const e of out) totalW += e.w;
      const massPerWeight = rank[u]! / totalW;
      for (const e of out) {
        next[e.idx]! += massPerWeight * e.w;
      }
    }

    // Restart-with-personalization:
    //   next[v] = α · neighbor-mass[v] + (1−α) · personalization[v] + α · dangling · personalization[v]
    // The dangling redistribution lands on the personalization vector (PPR
    // convention) — keeps total mass at 1 and favors the source.
    let maxDelta = 0;
    for (let v = 0; v < n; v++) {
      const updated =
        alpha * next[v]! + (1 - alpha) * personalization[v]! + alpha * dangling * personalization[v]!;
      const d = Math.abs(updated - rank[v]!);
      if (d > maxDelta) maxDelta = d;
      next[v] = updated;
    }
    rank = next;
    if (maxDelta < tol) break;
  }

  // Sort by rank descending, exclude source, take top K.
  const sorted: PprNeighbor[] = [];
  for (let i = 0; i < n; i++) {
    if (i === sourceIdx) continue;
    if (rank[i]! <= 0) continue;
    sorted.push({ id: idxToId[i]!, score: rank[i]! });
  }
  sorted.sort((a, b) => b.score - a.score);
  return sorted.slice(0, topK);
}
