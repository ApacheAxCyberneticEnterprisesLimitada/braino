import type { Entity } from "@doco/shared";
import { describe, expect, it } from "vitest";
import { deriveEdges } from "../edges.js";

describe("deriveEdges", () => {
  it("materializes BPMN sequence_to as forward sequence_flow edges", () => {
    const edges = deriveEdges({
      id: "decision_01KSJ000000000000000000000",
      doco_id: "doco_01KSJ000000000000000000000",
      node_type: "decision",
      decision: "Route payment path",
      question: "Does the user have credits?",
      chosen: "Route to the matching payment action.",
      decided_by: "principal_01KSJ000000000000000000001",
      decided_at: "2026-05-26T00:00:00.000Z",
      created_at: "2026-05-26T00:00:00.000Z",
      created_by: "user_01KSJ000000000000000000002",
      sequence_to: [
        "action_01KSJ000000000000000000003",
        {
          target: "action_01KSJ000000000000000000004",
          label: "No credits",
          condition: "credits = 0",
          kind: "conditional",
        },
      ],
    } as unknown as Entity);

    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from_id: "decision_01KSJ000000000000000000000",
          to_id: "action_01KSJ000000000000000000003",
          edge_type: "sequence_flow",
        }),
        expect.objectContaining({
          from_id: "decision_01KSJ000000000000000000000",
          to_id: "action_01KSJ000000000000000000004",
          edge_type: "sequence_flow",
          edge_props: {
            label: "No credits",
            condition: "credits = 0",
            kind: "conditional",
          },
        }),
      ]),
    );
  });

  it("materializes Decision.implemented_by as implemented_by edges to PR/commit References", () => {
    const edges = deriveEdges({
      id: "decision_01KSJ000000000000000000000",
      doco_id: "doco_01KSJ000000000000000000000",
      node_type: "decision",
      decision: "Rename active lifecycle to accepted",
      question: "What ships this rename?",
      chosen: "These PRs.",
      implemented_by: [
        "reference_01KSJ000000000000000000003",
        "reference_01KSJ000000000000000000004",
      ],
    } as unknown as Entity);

    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from_id: "decision_01KSJ000000000000000000000",
          from_node_type: "decision",
          to_id: "reference_01KSJ000000000000000000003",
          to_node_type: "reference",
          edge_type: "implemented_by",
        }),
        expect.objectContaining({
          from_id: "decision_01KSJ000000000000000000000",
          to_id: "reference_01KSJ000000000000000000004",
          edge_type: "implemented_by",
        }),
      ]),
    );
  });
});
