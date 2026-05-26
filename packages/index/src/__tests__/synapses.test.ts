import type { Entity } from "@doco/shared";
import { describe, expect, it } from "vitest";
import { deriveSynapses } from "../synapses.js";

describe("deriveSynapses", () => {
  it("materializes BPMN sequence_to as forward sequence_flow edges", () => {
    const synapses = deriveSynapses({
      id: "decision_01KSJ000000000000000000000",
      doco_id: "doco_01KSJ000000000000000000000",
      neuron_type: "decision",
      decision: "Route payment path",
      question: "Does the user have credits?",
      chosen: "Route to the matching payment action.",
      decided_by: "principal_01KSJ000000000000000000001",
      decided_at: "2026-05-26T00:00:00.000Z",
      created_at: "2026-05-26T00:00:00.000Z",
      created_by: "collaborator_01KSJ000000000000000000002",
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

    expect(synapses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from_id: "decision_01KSJ000000000000000000000",
          to_id: "action_01KSJ000000000000000000003",
          synapse_type: "sequence_flow",
        }),
        expect.objectContaining({
          from_id: "decision_01KSJ000000000000000000000",
          to_id: "action_01KSJ000000000000000000004",
          synapse_type: "sequence_flow",
          synapse_props: {
            label: "No credits",
            condition: "credits = 0",
            kind: "conditional",
          },
        }),
      ]),
    );
  });
});
