import type { Entity } from "@doco/shared";
import { describe, expect, it } from "vitest";
import { deriveEdges } from "../edges.js";

describe("deriveEdges", () => {
  it("does not derive graph links from node JSON", () => {
    const edges = deriveEdges({
      id: "decision_01KSJ000000000000000000000",
      doco_id: "doco_01KSJ000000000000000000000",
      node_type: "decision",
      decision: "Route payment path",
      question: "Does the user have credits?",
      chosen: "Route to the matching payment action.",
      decided_at: "2026-05-26T00:00:00.000Z",
      created_at: "2026-05-26T00:00:00.000Z",
      created_by: "user_01KSJ000000000000000000002",
      graph_hint: {
        target: "action_01KSJ000000000000000000004",
        label: "No credits",
      },
    } as unknown as Entity);

    expect(edges).toEqual([]);
  });

  it("does not derive non-reserved nested references", () => {
    const edges = deriveEdges({
      id: "decision_01KSJ000000000000000000000",
      doco_id: "doco_01KSJ000000000000000000000",
      node_type: "decision",
      decision: "Rename active lifecycle to accepted",
      question: "What ships this rename?",
      chosen: "These PRs.",
      premises: [{ ref: "reference_01KSJ000000000000000000003", as: "evidence" }],
    } as unknown as Entity);

    expect(edges).toEqual([]);
  });
});
