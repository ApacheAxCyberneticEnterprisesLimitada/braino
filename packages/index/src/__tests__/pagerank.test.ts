import { describe, expect, it } from "vitest";
import { globalPageRank } from "../pagerank.js";

// A graph where edge *direction* flips the ranking, mirroring the real
// Doco shape: many events "serve" one intent (edge from=event → to=intent),
// while a decision fans *out* to several actions (from=decision → to=action).
//
//   e1 ─┐
//   e2 ─┼─► I            D ─► a1, a2, a3, a4
//   e3 ─┘
//
// Undirected, the decision wins: it has the highest plain degree (4), and
// undirected PageRank trends toward degree. Directed, the intent wins: it
// is the *target* of three edges (an authority/sink that collects mass),
// whereas the decision is a pure source that sprays its mass outward.
function fixture() {
  return [
    { from: "e1", to: "I", edge_type: "supports" },
    { from: "e2", to: "I", edge_type: "supports" },
    { from: "e3", to: "I", edge_type: "supports" },
    { from: "D", to: "a1", edge_type: "flows_to" },
    { from: "D", to: "a2", edge_type: "flows_to" },
    { from: "D", to: "a3", edge_type: "flows_to" },
    { from: "D", to: "a4", edge_type: "flows_to" },
  ];
}

function scoreOf(ranked: { id: string; score: number }[], id: string): number {
  const hit = ranked.find((r) => r.id === id);
  if (!hit) throw new Error(`missing ${id}`);
  return hit.score;
}

describe("globalPageRank direction", () => {
  it("undirected ranks the high-degree decision above the intent", () => {
    const ranked = globalPageRank(fixture(), { directed: false });
    expect(scoreOf(ranked, "D")).toBeGreaterThan(scoreOf(ranked, "I"));
  });

  it("directed ranks the intent (edge target / authority) above the decision", () => {
    const ranked = globalPageRank(fixture(), { directed: true });
    expect(scoreOf(ranked, "I")).toBeGreaterThan(scoreOf(ranked, "D"));
  });

  it("directed: an intent served by more events outranks one served by fewer", () => {
    const ranked = globalPageRank(
      [
        { from: "x1", to: "Ibig", edge_type: "supports" },
        { from: "x2", to: "Ibig", edge_type: "supports" },
        { from: "x3", to: "Ibig", edge_type: "supports" },
        { from: "y1", to: "Ismall", edge_type: "supports" },
      ],
      { directed: true },
    );
    expect(scoreOf(ranked, "Ibig")).toBeGreaterThan(scoreOf(ranked, "Ismall"));
  });
});
