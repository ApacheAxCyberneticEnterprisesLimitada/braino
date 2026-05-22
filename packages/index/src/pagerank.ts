/**
 * Personalized PageRank (PPR) — given a source node, returns the most
 * relevant other nodes by random-walk-with-restart, treating the
 * indexer's synapses as undirected.
 *
 * Used by the entity-detail page's graph view (ADR-076) to pick which
 * neighbors to surface around the focal node.
 *
 * For the meta-Doco's ~130-entity scale, this runs in well under
 * 100ms with default iters. Iterates until rank deltas drop below a
 * tolerance; capped at iters.
 */

export type PprSynapseAttribution = "explicit" | "doco-auto";

export interface PprSynapse {
  from: string;
  to: string;
  /** Optional edge type; lets callers tune relevance by relationship kind. */
  synapse_type?: string;
  /**
   * Optional edge attribution: 'explicit' (declared in source frontmatter)
   * or 'doco-auto' (LLM-detected). Auto synapses are down-weighted by default
   * so a flood of LLM suggestions can't dominate the graph. Per the
   * `pagerank-weights-explicit-synapses-higher` ADR.
   */
  attribution?: PprSynapseAttribution;
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
   * more random-walker mass flows along that edge.
   *
   * The second arg is the edge attribution — implicit (LLM-detected) synapses
   * default to 1/4 the weight of explicit ones, so a flood of auto-detected
   * synapses can't dominate the ranking.
   */
  synapseWeight?: (synapse_type: string | undefined, attribution?: PprSynapseAttribution) => number;
}

/**
 * Default weight: 1× for every edge type, then scaled by attribution:
 * explicit synapses get full weight; doco-auto synapses
 * get `IMPLICIT_EDGE_WEIGHT_FACTOR` (default 0.25). Tunable via the
 * `synapseWeight` option for callers that want different multipliers.
 */
const IMPLICIT_EDGE_WEIGHT_FACTOR = 0.25;
export function defaultSynapseWeight(
  _synapseType: string | undefined,
  attribution?: PprSynapseAttribution,
): number {
  const base = 1;
  return attribution === "doco-auto" ? base * IMPLICIT_EDGE_WEIGHT_FACTOR : base;
}

function mustGetIndex(index: Map<string, number>, id: string): number {
  const value = index.get(id);
  if (value === undefined) throw new Error(`Missing PageRank node index for ${id}`);
  return value;
}

function mustGetBucket<T>(buckets: T[][], index: number): T[] {
  const bucket = buckets[index];
  if (!bucket) throw new Error(`Missing PageRank adjacency bucket ${index}`);
  return bucket;
}

function read(values: Float64Array, index: number): number {
  return values[index] ?? 0;
}

function add(values: Float64Array, index: number, amount: number): void {
  values[index] = read(values, index) + amount;
}

export function personalizedPageRank(
  synapses: PprSynapse[],
  sourceId: string,
  options: PprOptions = {},
): PprNeighbor[] {
  const alpha = options.alpha ?? 0.85;
  const iters = options.iters ?? 50;
  const topK = options.topK ?? 30;
  const tol = options.tol ?? 1e-6;
  const synapseWeight = options.synapseWeight ?? defaultSynapseWeight;

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
  for (const e of synapses) {
    idx(e.from);
    idx(e.to);
  }
  const n = idToIdx.size;
  const idxToId: string[] = new Array(n);
  for (const [id, i] of idToIdx) idxToId[i] = id;
  const sourceIdx = mustGetIndex(idToIdx, sourceId);

  // Build undirected weighted adjacency (in semantic terms, "A → B" and
  // "B referenced by A" are equally informative for relevance — distinguishing
  // them in PPR would weight the central node toward only its outbound synapses,
  // which is wrong for context discovery).
  // Per-edge weight via options.synapseWeight (default 1.0). Out-degree becomes
  // the sum of incident weights.
  const neighbors: { idx: number; w: number }[][] = Array.from({ length: n }, () => []);
  for (const e of synapses) {
    const a = mustGetIndex(idToIdx, e.from);
    const b = mustGetIndex(idToIdx, e.to);
    if (a === b) continue; // self-synapses add nothing
    const w = synapseWeight(e.synapse_type, e.attribution);
    if (w <= 0) continue;
    mustGetBucket(neighbors, a).push({ idx: b, w });
    mustGetBucket(neighbors, b).push({ idx: a, w });
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
      const out = mustGetBucket(neighbors, u);
      if (out.length === 0) {
        dangling += read(rank, u);
        continue;
      }
      // Weighted: distribute mass proportional to each outgoing edge's weight.
      let totalW = 0;
      for (const e of out) totalW += e.w;
      const massPerWeight = read(rank, u) / totalW;
      for (const e of out) {
        add(next, e.idx, massPerWeight * e.w);
      }
    }

    // Restart-with-personalization:
    //   next[v] = α · neighbor-mass[v] + (1−α) · personalization[v] + α · dangling · personalization[v]
    // The dangling redistribution lands on the personalization vector (PPR
    // convention) — keeps total mass at 1 and favors the source.
    let maxDelta = 0;
    for (let v = 0; v < n; v++) {
      const updated =
        alpha * read(next, v) +
        (1 - alpha) * read(personalization, v) +
        alpha * dangling * read(personalization, v);
      const d = Math.abs(updated - read(rank, v));
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
    const score = read(rank, i);
    const id = idxToId[i];
    if (score <= 0 || !id) continue;
    sorted.push({ id, score });
  }
  sorted.sort((a, b) => b.score - a.score);
  return sorted.slice(0, topK);
}

/**
 * Global PageRank — same iteration as personalizedPageRank but with a
 * uniform restart vector (1/N at every node) instead of a single source.
 * Returns every node's score, no top-K cutoff. Cheap enough at <100k nodes
 * to compute on every entity-detail page load.
 */
export function globalPageRank(
  synapses: PprSynapse[],
  options: Omit<PprOptions, "topK"> = {},
): PprNeighbor[] {
  const alpha = options.alpha ?? 0.85;
  const iters = options.iters ?? 50;
  const tol = options.tol ?? 1e-6;
  const synapseWeight = options.synapseWeight ?? defaultSynapseWeight;

  const idToIdx = new Map<string, number>();
  function idx(id: string): number {
    let i = idToIdx.get(id);
    if (i === undefined) {
      i = idToIdx.size;
      idToIdx.set(id, i);
    }
    return i;
  }
  for (const e of synapses) {
    idx(e.from);
    idx(e.to);
  }
  const n = idToIdx.size;
  if (n === 0) return [];
  const idxToId: string[] = new Array(n);
  for (const [id, i] of idToIdx) idxToId[i] = id;

  const neighbors: { idx: number; w: number }[][] = Array.from({ length: n }, () => []);
  for (const e of synapses) {
    const a = mustGetIndex(idToIdx, e.from);
    const b = mustGetIndex(idToIdx, e.to);
    if (a === b) continue;
    const w = synapseWeight(e.synapse_type, e.attribution);
    if (w <= 0) continue;
    mustGetBucket(neighbors, a).push({ idx: b, w });
    mustGetBucket(neighbors, b).push({ idx: a, w });
  }

  // Uniform personalization: 1/N at every node. Initial rank also uniform.
  const uniform = 1 / n;
  const personalization = new Float64Array(n).fill(uniform);
  let rank = new Float64Array(n).fill(uniform);

  for (let it = 0; it < iters; it++) {
    const next = new Float64Array(n);
    let dangling = 0;
    for (let u = 0; u < n; u++) {
      const out = mustGetBucket(neighbors, u);
      if (out.length === 0) {
        dangling += read(rank, u);
        continue;
      }
      let totalW = 0;
      for (const e of out) totalW += e.w;
      const massPerWeight = read(rank, u) / totalW;
      for (const e of out) {
        add(next, e.idx, massPerWeight * e.w);
      }
    }
    let maxDelta = 0;
    for (let v = 0; v < n; v++) {
      const updated =
        alpha * read(next, v) +
        (1 - alpha) * read(personalization, v) +
        alpha * dangling * read(personalization, v);
      const d = Math.abs(updated - read(rank, v));
      if (d > maxDelta) maxDelta = d;
      next[v] = updated;
    }
    rank = next;
    if (maxDelta < tol) break;
  }

  const out: PprNeighbor[] = [];
  for (let i = 0; i < n; i++) {
    const id = idxToId[i];
    if (!id) continue;
    out.push({ id, score: read(rank, i) });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
