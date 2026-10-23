import { type RetrievalReport, evaluateRetrieval } from "./retrieval-metrics.js";

export interface BenchmarkPoint {
  id: string;
  collectionId: string;
  vector: number[];
}

export interface BenchmarkQuery {
  query: string;
  collectionId: string;
  vector: number[];
  relevantIds: string[];
}

export interface BenchmarkCorpus {
  points: BenchmarkPoint[];
  queries: BenchmarkQuery[];
}

export interface BenchmarkQueryResult {
  query: string;
  ranked: string[];
  exact: string[];
  relevantIds: string[];
}

export interface VectorStoreReport {
  engine: string;
  pointCount: number;
  queryCount: number;
  k: number;
  ingestMs: number;
  latencyMs: { p50: number; p75: number; p95: number };
  annRecallAtK: number;
  quality: RetrievalReport;
}

interface BuildCorpusOptions {
  size: number;
  dimensions: number;
  seed?: number;
  queryCount?: number;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}

/**
 * Build the same synthetic corpus for every engine. The queries are slightly
 * perturbed copies of labeled points, while 20% of points belong to another
 * collection so the benchmark also exercises tenant filtering.
 */
export function buildBenchmarkCorpus(options: BuildCorpusOptions): BenchmarkCorpus {
  if (!Number.isInteger(options.size) || options.size < 1) throw new Error("size must be positive");
  if (!Number.isInteger(options.dimensions) || options.dimensions < 2) {
    throw new Error("dimensions must be at least 2");
  }

  const random = seededRandom(options.seed ?? 42);
  const queryCount = Math.min(options.queryCount ?? 10, options.size);
  const points: BenchmarkPoint[] = [];
  for (let index = 0; index < options.size; index++) {
    const vector = normalize(Array.from({ length: options.dimensions }, () => random() * 2 - 1));
    points.push({
      id: `point-${String(index).padStart(8, "0")}`,
      collectionId: index < queryCount || index % 5 !== 0 ? "eval" : "other",
      vector,
    });
  }

  const queries = points.slice(0, queryCount).map((point, index) => ({
    query: `needle-${index + 1}`,
    collectionId: "eval",
    vector: normalize(point.vector.map((value) => value + (random() * 2 - 1) * 0.01)),
    relevantIds: [point.id],
  }));

  return { points, queries };
}

function cosine(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

/** Exact cosine search, used only as the ANN-fidelity ground truth. */
export function exactRank(
  query: number[],
  points: BenchmarkPoint[],
  collectionId: string,
  k: number,
): string[] {
  return points
    .filter((point) => point.collectionId === collectionId)
    .map((point) => ({ id: point.id, score: cosine(query, point.vector) }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, k)
    .map((point) => point.id);
}

/** Nearest-rank percentile: p95 is an observed latency, never an interpolation. */
export function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  if (fraction < 0 || fraction > 1) throw new Error("percentile must be between 0 and 1");
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index];
}

export function summarizeVectorStoreRun(input: {
  engine: string;
  queryResults: BenchmarkQueryResult[];
  durationsMs: number[];
  ingestMs: number;
  pointCount: number;
  k: number;
}): VectorStoreReport {
  const quality = evaluateRetrieval(
    input.queryResults.map((result) => ({
      query: result.query,
      ranked: result.ranked,
      relevance: new Set(result.relevantIds),
    })),
    [1, Math.min(5, input.k), input.k].filter(
      (value, index, values) => values.indexOf(value) === index,
    ),
  );

  let overlap = 0;
  let possible = 0;
  for (const result of input.queryResults) {
    const exact = new Set(result.exact.slice(0, input.k));
    overlap += result.ranked.slice(0, input.k).filter((id) => exact.has(id)).length;
    possible += Math.min(input.k, result.exact.length);
  }

  return {
    engine: input.engine,
    pointCount: input.pointCount,
    queryCount: input.queryResults.length,
    k: input.k,
    ingestMs: input.ingestMs,
    latencyMs: {
      p50: percentile(input.durationsMs, 0.5),
      p75: percentile(input.durationsMs, 0.75),
      p95: percentile(input.durationsMs, 0.95),
    },
    annRecallAtK: possible === 0 ? 0 : overlap / possible,
    quality,
  };
}
