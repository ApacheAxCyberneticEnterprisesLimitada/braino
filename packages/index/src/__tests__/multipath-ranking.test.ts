import { describe, expect, it } from "vitest";
import { fuseCandidateRanks, protectRankedHead } from "../multipath-retrieval.js";

describe("multi-path rank fusion", () => {
  it("promotes corroborated graph evidence without displacing the direct head", () => {
    const fused = fuseCandidateRanks({
      chunk_lexical: ["direct", "lexical-only"],
      chunk_vector: ["direct", "vector-only"],
      graph_relation: ["graph-only"],
      neighbor_mention: ["graph-only"],
    });
    const rankedIds = protectRankedHead(
      ["direct", "lexical-only", "vector-only"],
      fused.map((candidate) => candidate.id),
      1,
    );

    expect(rankedIds).toEqual(["direct", "graph-only", "lexical-only", "vector-only"]);
    expect(fused[0]?.id).toBe("graph-only");
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
