import { describe, expect, it } from "vitest";
import type { Entity } from "@doco/shared";
import { deriveEdges } from "../edges.js";

function asEntity(obj: Record<string, unknown>): Entity {
  return obj as unknown as Entity;
}

describe("deriveEdges", () => {
  it("emits no edges for an entity with only id + doco_id", () => {
    expect(
      deriveEdges(
        asEntity({
          id: "intent_01KR441EAAA1AAA1AAA1AAA1AAA",
          doco_id: "doco_01KR441EA0ZDMF0N5DY38GSVS3",
          node_type: "intent",
        }),
      ),
    ).toEqual([]);
  });

  it("maps known relationship fields to canonical edge types", () => {
    const edges = deriveEdges(
      asEntity({
        id: "decision_01KR441EAAA1AAA1AAA1AAA1AAA",
        doco_id: "doco_01KR441EA0ZDMF0N5DY38GSVS3",
        node_type: "decision",
        intent_ids: ["intent_01KR441EAAA2AAA2AAA2AAA2AA"],
        rules_consulted: ["rule_01KR441EAAA3AAA3AAA3AAA3AA"],
        decided_by: "torrenegra", // not an ID — should not become an edge
        scopes: ["scope_01KR441EAAA4AAA4AAA4AAA4AA"],
        follows: ["decision_01KR441EAAA5AAA5AAA5AAA5AA"],
      }),
    );
    const byType = new Map(edges.map((e) => [e.edge_type, e]));
    expect(byType.get("serves")?.to_id).toBe("intent_01KR441EAAA2AAA2AAA2AAA2AA");
    expect(byType.get("consults")?.to_id).toBe("rule_01KR441EAAA3AAA3AAA3AAA3AA");
    expect(byType.get("in_scope_of")?.to_id).toBe("scope_01KR441EAAA4AAA4AAA4AAA4AA");
    expect(byType.get("follows")?.to_id).toBe("decision_01KR441EAAA5AAA5AAA5AAA5AA");
    // decided_by is now an ActorString, not an EntityId, so emits no edge.
    expect(edges.find((e) => e.edge_type === "decided_by")).toBeUndefined();
  });

  it("skips self-edges", () => {
    const edges = deriveEdges(
      asEntity({
        id: "decision_01KR441EAAA1AAA1AAA1AAA1AAA",
        doco_id: "doco_01KR441EA0ZDMF0N5DY38GSVS3",
        node_type: "decision",
        // Deliberate self-reference — should be dropped.
        superseded_by: "decision_01KR441EAAA1AAA1AAA1AAA1AAA",
      }),
    );
    expect(edges).toEqual([]);
  });

  it("skips cross-Doco namespaced IDs", () => {
    const edges = deriveEdges(
      asEntity({
        id: "decision_01KR441EAAA1AAA1AAA1AAA1AAA",
        doco_id: "doco_01KR441EA0ZDMF0N5DY38GSVS3",
        node_type: "decision",
        intent_ids: ["other-doco:intent_01KR441EAAA2AAA2AAA2AAA2AA"],
      }),
    );
    expect(edges).toEqual([]);
  });

  it("walks Reasoning.premises[]: each premise becomes a 'premise' edge with `as` props", () => {
    const edges = deriveEdges(
      asEntity({
        id: "reasoning_01KR441EAAA1AAA1AAA1AAA1AAA",
        doco_id: "doco_01KR441EA0ZDMF0N5DY38GSVS3",
        node_type: "reasoning",
        premises: [
          { node_type: "intent", ref: "intent_01KR441EAAA2AAA2AAA2AAA2AA", as: "the goal" },
          { node_type: "rule", ref: "rule_01KR441EAAA3AAA3AAA3AAA3AA", as: "the constraint" },
        ],
      }),
    );
    const premiseEdges = edges.filter((e) => e.edge_type === "premise");
    expect(premiseEdges).toHaveLength(2);
    expect(premiseEdges[0]?.edge_props).toEqual({ as: "the goal" });
  });

  it("does NOT walk Action.inputs or Action.outputs — those are free-form bags (Phase 23 cleanup)", () => {
    const edges = deriveEdges(
      asEntity({
        id: "action_01KR441EAAA1AAA1AAA1AAA1AAA",
        doco_id: "doco_01KR441EA0ZDMF0N5DY38GSVS3",
        node_type: "action",
        actor_id: "torrenegra",
        verb: "do_thing",
        // These would have produced noisy pseudo-edges in earlier versions.
        inputs: {
          assets_provided_by: "intent_01KR441EAAA2AAA2AAA2AAA2AA",
          predecessor: "action_01KR441EAAA3AAA3AAA3AAA3AA",
        },
        outputs: {
          followup: "decision_01KR441EAAA4AAA4AAA4AAA4AA",
        },
      }),
    );
    for (const e of edges) {
      expect(e.edge_type.startsWith("inputs.")).toBe(false);
      expect(e.edge_type.startsWith("outputs.")).toBe(false);
    }
  });
});
