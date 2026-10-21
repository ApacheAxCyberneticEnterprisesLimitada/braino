import { describe, expect, it } from "vitest";
import { fuseCandidateRanks, protectRankedHead } from "../multipath-retrieval.js";

describe("multi-path rank fusion", () => {
  it("rewards agreement between lexical and vector retrieval over graph-only noise", () => {
    const ranked = fuseCandidateRanks({
      chunk_lexical: ["direct", "lexical-only"],
      chunk_vector: ["direct", "vector-only"],
      graph_relation: ["graph-only"],
      neighbor_mention: ["graph-only"],
    });

    expect(ranked.map((candidate) => candidate.id)).toEqual([
      "direct",
      "lexical-only",
      "vector-only",
      "graph-only",
    ]);
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);
  });

  it("uses stable ids to break equal-score ties", () => {
    expect(
      fuseCandidateRanks({ chunk_lexical: ["b", "a"], chunk_vector: ["a", "b"] }).map(
        (candidate) => candidate.id,
      ),
    ).toEqual(["a", "b"]);
  });

  it("lets graph evidence enrich the tail without displacing the direct head", () => {
    expect(
      protectRankedHead(
        ["direct-a", "direct-b", "direct-c"],
        ["graph-a", "direct-a", "graph-b", "direct-b", "direct-c"],
        2,
      ),
    ).toEqual(["direct-a", "direct-b", "graph-a", "graph-b", "direct-c"]);
  });
});
