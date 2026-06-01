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
          edge_type: "sequence_flow",
          edge_props: { label: "approved" },
        }),
        expect.objectContaining({ from_id: D, to_id: ACTION, edge_type: "preceded_by" }),
        expect.objectContaining({ from_id: D, to_id: INTENT, edge_type: "serves" }),
        expect.objectContaining({ from_id: D, to_id: D_OLD, edge_type: "enacts" }),
        expect.objectContaining({ from_id: D, to_id: RULE, edge_type: "gated_by" }),
        expect.objectContaining({ from_id: D, to_id: RULE, edge_type: "consults" }),
        expect.objectContaining({ from_id: D, to_id: ACTION, edge_type: "tests" }),
        expect.objectContaining({ from_id: D, to_id: D_OLD, edge_type: "born_from" }),
        expect.objectContaining({ from_id: D, to_id: D_OLD, edge_type: "superseded_by" }),
        expect.objectContaining({ from_id: D, to_id: REFERENCE, edge_type: "implemented_by" }),
        expect.objectContaining({ from_id: D, to_id: PRINCIPAL, edge_type: "reports_to" }),
        expect.objectContaining({ from_id: D, to_id: PRINCIPAL, edge_type: "dotted_reports_to" }),
        expect.objectContaining({ from_id: D, to_id: PRINCIPAL, edge_type: "same_occupant_as" }),
        expect.objectContaining({ from_id: D, to_id: PRINCIPAL, edge_type: "performed_by" }),
        expect.objectContaining({ from_id: D, to_id: PRINCIPAL, edge_type: "owned_by" }),
        expect.objectContaining({ from_id: D, to_id: PARENT_INTENT, edge_type: "has_parent" }),
        expect.objectContaining({ from_id: D, to_id: PRINCIPAL, edge_type: "has_stakeholder" }),
        expect.objectContaining({ from_id: D, to_id: PRINCIPAL, edge_type: "decided_by" }),
        expect.objectContaining({ from_id: D, to_id: ACTION, edge_type: "templated_by" }),
        expect.objectContaining({ from_id: D, to_id: RULE, edge_type: "relates_to" }),
      ]),
    );
    expect([...new Set(edges.map((e) => e.edge_type))].sort()).toEqual([...EDGE_TYPES].sort());
  });

  it("projects a Log's actor_id → performed_by and template_id → templated_by", () => {
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
        expect.objectContaining({ from_id: LOG, to_id: PRINCIPAL, edge_type: "performed_by" }),
        expect.objectContaining({ from_id: LOG, to_id: ACTION, edge_type: "templated_by" }),
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
      expect.objectContaining({ from_id: INTENT, to_id: PARENT_INTENT, edge_type: "has_parent" }),
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

    // actor_id → performed_by is a relation kind; target → acts_on and
    // triggered_by are not write-gateable relation kinds and are not persisted
    // by the managed-edge reconciler.
    expect(edges).toEqual([
      expect.objectContaining({ from_id: ACTION, to_id: PRINCIPAL, edge_type: "performed_by" }),
    ]);
    for (const e of edges) expect(allowed.has(e.edge_type)).toBe(true);
  });
});
