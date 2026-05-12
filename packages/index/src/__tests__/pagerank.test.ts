import { describe, expect, it } from "vitest";
import { personalizedPageRank, type PprEdge } from "../pagerank.js";

describe("personalizedPageRank", () => {
  it("returns nothing when there are no edges", () => {
    expect(personalizedPageRank([], "a")).toEqual([]);
  });

  it("ranks direct neighbors above 2-hop neighbors", () => {
    // a─b, b─c, b─d, c─d  →  from a, b is the closest hub.
    const edges: PprEdge[] = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "b", to: "d" },
      { from: "c", to: "d" },
    ];
    const ranks = personalizedPageRank(edges, "a", { topK: 10 });
    const ids = ranks.map((r) => r.id);
    expect(ids[0]).toBe("b");
    expect(ids).not.toContain("a"); // source is excluded
    // c + d are 2 hops; b is 1 hop. b should outrank both.
    const bScore = ranks.find((r) => r.id === "b")!.score;
    const cScore = ranks.find((r) => r.id === "c")!.score;
    expect(bScore).toBeGreaterThan(cScore);
  });

  it("treats edges as undirected (B→A surfaces from A)", () => {
    const edges: PprEdge[] = [{ from: "b", to: "a" }];
    const ranks = personalizedPageRank(edges, "a", { topK: 5 });
    expect(ranks.map((r) => r.id)).toEqual(["b"]);
  });

  it("excludes self-edges silently", () => {
    const edges: PprEdge[] = [
      { from: "a", to: "a" },
      { from: "a", to: "b" },
    ];
    const ranks = personalizedPageRank(edges, "a", { topK: 5 });
    expect(ranks.map((r) => r.id)).toEqual(["b"]);
  });

  it("respects topK", () => {
    const edges: PprEdge[] = [
      { from: "a", to: "b" },
      { from: "a", to: "c" },
      { from: "a", to: "d" },
      { from: "a", to: "e" },
    ];
    const ranks = personalizedPageRank(edges, "a", { topK: 2 });
    expect(ranks).toHaveLength(2);
  });

  it("edge-type weighting boosts the heavier edges", () => {
    // a is connected to b via a normal edge and to c via a strongly-weighted edge.
    // Both are direct neighbors, but `in_scope_of` should pull c higher.
    const edges: PprEdge[] = [
      { from: "a", to: "b", edge_type: "serves" },
      { from: "a", to: "c", edge_type: "in_scope_of" },
    ];
    const ranks = personalizedPageRank(edges, "a", {
      topK: 5,
      edgeWeight: (t) => (t === "in_scope_of" ? 10 : 1),
    });
    const cIndex = ranks.findIndex((r) => r.id === "c");
    const bIndex = ranks.findIndex((r) => r.id === "b");
    expect(cIndex).toBeLessThan(bIndex);
  });

  it("zero-weight edges are dropped (no contribution)", () => {
    const edges: PprEdge[] = [
      { from: "a", to: "b", edge_type: "noise" },
      { from: "a", to: "c", edge_type: "serves" },
    ];
    const ranks = personalizedPageRank(edges, "a", {
      topK: 5,
      edgeWeight: (t) => (t === "noise" ? 0 : 1),
    });
    expect(ranks.map((r) => r.id)).toEqual(["c"]);
  });

  it("converges quickly on small graphs (under 50 iters)", () => {
    const edges: PprEdge[] = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "d" },
    ];
    // tol is the convergence threshold; with these defaults the run halts well
    // before iters cap. If iteration logic regresses, this'd hit the cap and
    // give different ranks.
    const ranks = personalizedPageRank(edges, "a", { topK: 5 });
    expect(ranks.map((r) => r.id)).toEqual(["b", "c", "d"]);
  });
});
