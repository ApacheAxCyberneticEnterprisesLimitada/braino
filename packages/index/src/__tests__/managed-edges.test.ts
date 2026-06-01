import { EDGE_TYPES, type Entity } from "@doco/shared";
import { describe, expect, it } from "vitest";
import { MANAGED_RELATION_EDGE_TYPES, managedEdges } from "../edges.js";

// `managedEdges` is the set of first-class edges the capture path authors from
// node relation fields. The invariant now covers every relation kind: relation
// fields may be accepted as input sugar, but storage is edge-only.

const D = "decision_01KSJ000000000000000000000";
const PRINCIPAL = "principal_01KSJ000000000000000000001";
const D_OLD = "decision_01KSJ000000000000000000009";
const INTENT = "intent_01KSJ000000000000000000002";
const PARENT_INTENT = "intent_01KSJ000000000000000000003";
const RULE = "rule_01KSJ000000000000000000004";
const ACTION = "action_01KSJ000000000000000000005";
const LOG = "log_01KSJ000000000000000000006";
const IDEA = "idea_01KSJ000000000000000000007";
const USER = "user_01KSJ000000000000000000008";
const REFERENCE = "reference_01KSJ00000000000000000000B";

describe("MANAGED_RELATION_EDGE_TYPES", () => {
  it("are all valid, allow-listed EDGE_TYPES", () => {
    const allowed = new Set<string>(EDGE_TYPES);
    for (const t of MANAGED_RELATION_EDGE_TYPES) {
      expect(allowed.has(t)).toBe(true);
    }
  });

  it("covers every write-gateable relation kind", () => {
    expect([...MANAGED_RELATION_EDGE_TYPES].sort()).toEqual([...EDGE_TYPES].sort());
  });
});

describe("managedEdges", () => {
  it("projects every relation-shaped node field as a first-class managed edge", () => {
    const edges = managedEdges({
      id: D,
      doco_id: "doco_01KSJ000000000000000000000",
      node_type: "decision",
      decision: "Pick the payment path",
      question: "Which path?",
      chosen: "Route to matching action.",
      sequence_to: [{ target: ACTION, label: "approved" }],
      preceded_by: [ACTION],
      decided_by: PRINCIPAL,
      decided_at: "2026-05-26T00:00:00.000Z",
      superseded_by: D_OLD,
      intent_ids: [INTENT],
      rules_consulted: [RULE],
      decision_ids: [D_OLD],
      gated_by: [RULE],
      target_ref: ACTION,
      born_from: D_OLD,
      implemented_by: [REFERENCE],
      reports_to: PRINCIPAL,
      dotted_reports_to: [PRINCIPAL],
      same_occupant_as: [PRINCIPAL],
      actor_id: PRINCIPAL,
      owner_id: PRINCIPAL,
      parent_intent_id: PARENT_INTENT,
      stakeholders: [PRINCIPAL],
      template_id: ACTION,
      relates_to: [RULE],
    } as unknown as Entity);

    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from_id: D,
          to_id: ACTION,
          edge_type: "flows_to",
          edge_props: expect.objectContaining({
            label: "approved",
            role: "sequence",
            source_field: "sequence_to",
          }),
        }),
        expect.objectContaining({
          from_id: D,
          to_id: ACTION,
          edge_type: "flows_to",
          edge_props: expect.objectContaining({ role: "predecessor", source_field: "preceded_by" }),
        }),
        expect.objectContaining({
          from_id: D,
          to_id: INTENT,
          edge_type: "supports",
          edge_props: expect.objectContaining({ role: "serves", source_field: "intent_ids" }),
        }),
        expect.objectContaining({
          from_id: D,
          to_id: D_OLD,
          edge_type: "supports",
          edge_props: expect.objectContaining({ role: "enacts", source_field: "decision_ids" }),
        }),
        expect.objectContaining({
          from_id: D,
          to_id: RULE,
          edge_type: "constrained_by",
          edge_props: expect.objectContaining({ role: "gated_by", source_field: "gated_by" }),
        }),
        expect.objectContaining({
          from_id: D,
          to_id: RULE,
          edge_type: "constrained_by",
          edge_props: expect.objectContaining({
            role: "consults",
            source_field: "rules_consulted",
          }),
        }),
        expect.objectContaining({
          from_id: D,
          to_id: ACTION,
          edge_type: "supports",
          edge_props: expect.objectContaining({ role: "tests", source_field: "target_ref" }),
        }),
        expect.objectContaining({
          from_id: D,
          to_id: D_OLD,
          edge_type: "derived_from",
          edge_props: expect.objectContaining({ role: "born_from", source_field: "born_from" }),
        }),
        expect.objectContaining({
          from_id: D,
          to_id: D_OLD,
          edge_type: "replaces",
          edge_props: expect.objectContaining({
            role: "superseded_by",
            source_field: "superseded_by",
          }),
        }),
        expect.objectContaining({
          from_id: D,
          to_id: REFERENCE,
          edge_type: "supports",
          edge_props: expect.objectContaining({
            role: "implemented_by",
            source_field: "implemented_by",
          }),
        }),
        expect.objectContaining({
          from_id: D,
          to_id: PRINCIPAL,
          edge_type: "has_parent",
          edge_props: expect.objectContaining({ role: "reports_to", source_field: "reports_to" }),
        }),
        expect.objectContaining({
          from_id: D,
          to_id: PRINCIPAL,
          edge_type: "has_parent",
          edge_props: expect.objectContaining({
            role: "dotted_reports_to",
            source_field: "dotted_reports_to",
          }),
        }),
        expect.objectContaining({
          from_id: D,
          to_id: PRINCIPAL,
          edge_type: "relates_to",
          edge_props: expect.objectContaining({
            role: "same_occupant_as",
            source_field: "same_occupant_as",
          }),
        }),
        expect.objectContaining({
          from_id: D,
          to_id: PRINCIPAL,
          edge_type: "attributed_to",
          edge_props: expect.objectContaining({ role: "performed_by", source_field: "actor_id" }),
        }),
        expect.objectContaining({
          from_id: D,
          to_id: PRINCIPAL,
          edge_type: "attributed_to",
          edge_props: expect.objectContaining({ role: "owned_by", source_field: "owner_id" }),
        }),
        expect.objectContaining({
          from_id: D,
          to_id: PARENT_INTENT,
          edge_type: "has_parent",
          edge_props: expect.objectContaining({
            role: "parent_intent",
            source_field: "parent_intent_id",
          }),
        }),
        expect.objectContaining({
          from_id: D,
          to_id: PRINCIPAL,
          edge_type: "attributed_to",
          edge_props: expect.objectContaining({
            role: "has_stakeholder",
            source_field: "stakeholders",
          }),
        }),
        expect.objectContaining({
          from_id: D,
          to_id: PRINCIPAL,
          edge_type: "attributed_to",
          edge_props: expect.objectContaining({ role: "decided_by", source_field: "decided_by" }),
        }),
        expect.objectContaining({
          from_id: D,
          to_id: ACTION,
          edge_type: "derived_from",
          edge_props: expect.objectContaining({
            role: "templated_by",
            source_field: "template_id",
          }),
        }),
        expect.objectContaining({
          from_id: D,
          to_id: RULE,
          edge_type: "relates_to",
          edge_props: expect.objectContaining({ role: "relates_to", source_field: "relates_to" }),
        }),
      ]),
    );
    expect([...new Set(edges.map((e) => e.edge_type))].sort()).toEqual([...EDGE_TYPES].sort());
  });

  it("projects a Log's actor_id and template_id into canonical edge families", () => {
    const edges = managedEdges({
      id: LOG,
      doco_id: "doco_01KSJ000000000000000000000",
      node_type: "log",
      log: "Ran the step",
      verb: "ran",
      actor_id: PRINCIPAL,
      template_id: ACTION,
      happened_at: "2026-05-26T00:00:00.000Z",
    } as unknown as Entity);

    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from_id: LOG,
          to_id: PRINCIPAL,
          edge_type: "attributed_to",
          edge_props: expect.objectContaining({ role: "performed_by", source_field: "actor_id" }),
        }),
        expect.objectContaining({
          from_id: LOG,
          to_id: ACTION,
          edge_type: "derived_from",
          edge_props: expect.objectContaining({
            role: "templated_by",
            source_field: "template_id",
          }),
        }),
      ]),
    );
    expect(edges).toHaveLength(2);
  });

  it("projects an Intent's parent_intent_id → has_parent", () => {
    const edges = managedEdges({
      id: INTENT,
      doco_id: "doco_01KSJ000000000000000000000",
      node_type: "intent",
      intent: "Sub-goal",
      parent_intent_id: PARENT_INTENT,
    } as unknown as Entity);

    expect(edges).toEqual([
      expect.objectContaining({
        from_id: INTENT,
        to_id: PARENT_INTENT,
        edge_type: "has_parent",
        edge_props: expect.objectContaining({
          role: "parent_intent",
          source_field: "parent_intent_id",
        }),
      }),
    ]);
  });

  it("excludes proposer_id (idea → user is not a node→node edge)", () => {
    const edges = managedEdges({
      id: IDEA,
      doco_id: "doco_01KSJ000000000000000000000",
      node_type: "idea",
      idea: "An idea",
      proposer_id: USER,
    } as unknown as Entity);

    expect(edges).toEqual([]);
  });

  it("returns only node→node edges whose type is in EDGE_TYPES", () => {
    const allowed = new Set<string>(EDGE_TYPES);
    const edges = managedEdges({
      id: ACTION,
      doco_id: "doco_01KSJ000000000000000000000",
      node_type: "action",
      action: "Did a thing",
      verb: "did",
      actor_id: PRINCIPAL,
      target: INTENT,
      triggered_by: ["action_01KSJ00000000000000000000A"],
    } as unknown as Entity);

    // actor_id → attributed_to is a relation kind; target → acts_on and
    // triggered_by are not write-gateable relation kinds and are not persisted
    // by the managed-edge reconciler.
    expect(edges).toEqual([
      expect.objectContaining({
        from_id: ACTION,
        to_id: PRINCIPAL,
        edge_type: "attributed_to",
        edge_props: expect.objectContaining({ role: "performed_by", source_field: "actor_id" }),
      }),
    ]);
    for (const e of edges) expect(allowed.has(e.edge_type)).toBe(true);
  });
});
