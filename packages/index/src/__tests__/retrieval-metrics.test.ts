import { describe, expect, it } from "vitest";
import {
  evaluateRetrieval,
  nDCGAtK,
  precisionAtK,
  recallAtK,
  reciprocalRank,
} from "../retrieval-metrics.js";

describe("recallAtK", () => {
  const relevant = new Set(["a", "c"]);
  it("counts relevant hits within the cutoff over total relevant", () => {
    expect(recallAtK(["a", "b", "c"], relevant, 3)).toBe(1);
    expect(recallAtK(["a", "b", "c"], relevant, 1)).toBe(0.5);
    expect(recallAtK(["b", "d"], relevant, 2)).toBe(0);
  });
  it("is 0 when nothing is relevant", () => {
    expect(recallAtK(["a"], new Set(), 5)).toBe(0);
  });
});

describe("precisionAtK", () => {
  it("is relevant hits over the window size", () => {
    expect(precisionAtK(["a", "b", "c"], new Set(["a", "c"]), 2)).toBe(0.5);
    expect(precisionAtK(["a", "c"], new Set(["a", "c"]), 2)).toBe(1);
  });
  it("clamps the window to the available results", () => {
    expect(precisionAtK(["a"], new Set(["a", "c"]), 10)).toBe(1);
  });
});

describe("reciprocalRank", () => {
  it("is 1/rank of the first relevant hit", () => {
    expect(reciprocalRank(["x", "a", "y"], new Set(["a"]))).toBeCloseTo(1 / 2, 10);
    expect(reciprocalRank(["a"], new Set(["a"]))).toBe(1);
    expect(reciprocalRank(["x", "y"], new Set(["a"]))).toBe(0);
  });
});

describe("nDCGAtK", () => {
  it("is 1 for a perfect ranking", () => {
    expect(nDCGAtK(["a", "c"], new Set(["a", "c"]), 2)).toBeCloseTo(1, 10);
  });

  it("computes the binary case against a hand-derived value", () => {
    // gains [1,0,1]; DCG = 1 + 0 + 1/log2(4)=1.5; IDCG = 1 + 1/log2(3)=1.63093
    expect(nDCGAtK(["a", "b", "c"], new Set(["a", "c"]), 3)).toBeCloseTo(0.9197, 4);
  });

  it("uses graded gains for both DCG and the ideal ordering", () => {
    const graded = new Map([
      ["a", 2],
      ["b", 1],
    ]);
    expect(nDCGAtK(["a", "b"], graded, 2)).toBeCloseTo(1, 10);
    // [b,a]: DCG = 1 + 2/log2(3)=2.26186; IDCG = 2 + 1/log2(3)=2.63093
    expect(nDCGAtK(["b", "a"], graded, 2)).toBeCloseTo(0.8597, 4);
  });

  it("is 0 when no item carries positive gain", () => {
    expect(nDCGAtK(["x", "y"], new Set(["a"]), 5)).toBe(0);
  });
});

describe("evaluateRetrieval", () => {
  it("macro-averages metrics across queries at each cutoff", () => {
    const report = evaluateRetrieval(
      [
        { query: "q1", ranked: ["a", "b"], relevance: new Set(["a"]) }, // recall@1 = 1, rr = 1
        { query: "q2", ranked: ["b", "a"], relevance: new Set(["a"]) }, // recall@1 = 0, rr = 1/2
      ],
      [1, 2],
    );
    expect(report.queries).toBe(2);
    expect(report.recall[1]).toBeCloseTo(0.5, 10);
    expect(report.recall[2]).toBeCloseTo(1, 10);
    expect(report.mrr).toBeCloseTo((1 + 0.5) / 2, 10);
  });

  it("does not divide by zero on an empty eval set", () => {
    const report = evaluateRetrieval([], [5]);
    expect(report.queries).toBe(0);
    expect(report.recall[5]).toBe(0);
    expect(report.mrr).toBe(0);
  });
});
