import { describe, expect, it } from "vitest";
import {
  buildBenchmarkCorpus,
  exactRank,
  percentile,
  summarizeVectorStoreRun,
} from "../vector-store-benchmark.js";

describe("vector-store benchmark", () => {
  it("builds a deterministic normalized corpus with labeled needles", () => {
    const first = buildBenchmarkCorpus({ size: 20, dimensions: 16, seed: 7 });
    const second = buildBenchmarkCorpus({ size: 20, dimensions: 16, seed: 7 });

    expect(first).toEqual(second);
    expect(first.points).toHaveLength(20);
    expect(first.queries.length).toBeGreaterThan(0);
    expect(first.queries.every((query) => query.relevantIds.length === 1)).toBe(true);

    for (const point of first.points) {
      const norm = Math.sqrt(point.vector.reduce((sum, value) => sum + value * value, 0));
      expect(norm).toBeCloseTo(1, 6);
    }
  });

  it("computes the exact cosine ranking used as ANN ground truth", () => {
    const ranked = exactRank(
      [1, 0],
      [
        { id: "orthogonal", collectionId: "eval", vector: [0, 1] },
        { id: "near", collectionId: "eval", vector: [0.8, 0.2] },
        { id: "exact", collectionId: "eval", vector: [1, 0] },
        { id: "other-tenant", collectionId: "other", vector: [1, 0] },
      ],
      "eval",
      3,
    );

    expect(ranked).toEqual(["exact", "near", "orthogonal"]);
  });

  it("uses nearest-rank percentiles and summarizes quality and latency", () => {
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2);
    expect(percentile([4, 1, 3, 2], 0.95)).toBe(4);

    const report = summarizeVectorStoreRun({
      engine: "example",
      queryResults: [
        {
          query: "alpha",
          ranked: ["a", "x", "b"],
          exact: ["a", "b", "c"],
          relevantIds: ["a"],
        },
        {
          query: "beta",
          ranked: ["x", "d", "e"],
          exact: ["d", "e", "f"],
          relevantIds: ["d"],
        },
      ],
      durationsMs: [1, 2, 3, 4],
      ingestMs: 25,
      pointCount: 100,
      k: 3,
    });

    expect(report.quality.mrr).toBeCloseTo(0.75, 10);
    expect(report.annRecallAtK).toBeCloseTo(4 / 6, 10);
    expect(report.latencyMs).toEqual({ p50: 2, p75: 3, p95: 4 });
  });
});
