import { EDGE_TYPES, type Entity } from "@doco/shared";
import { describe, expect, it } from "vitest";
import { MANAGED_RELATION_EDGE_TYPES, managedEdges } from "../edges.js";

// Stage 1 of the "edges as the authored source of truth" refactor (option (i)).
// `managedEdges` is the set of first-class edges the capture path authors from
// the five promoted relationship columns that Stage 2 drops:
//   parent_intent_id → has_parent      (intent → intent)
//   actor_id         → performed_by    (action/log → principal)
//   superseded_by    → superseded_by   (decision → decision)
//   decided_by       → decided_by      (decision → principal)   [new edge type]
//   template_id      → templated_by    (log → action)           [new edge type]
// Everything else deriveEdges emits (serves, consults, reports_to, …) stays a
// field for now — those columns are not being dropped in Stage 2.

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

describe("MANAGED_RELATION_EDGE_TYPES", () => {
  it("are all valid, allow-listed EDGE_TYPES", () => {
    const allowed = new Set<string>(EDGE_TYPES);
    for (const t of MANAGED_RELATION_EDGE_TYPES) {
      expect(allowed.has(t)).toBe(true);
    }
  });

  it("covers exactly the five promoted-column relations", () => {
    expect([...MANAGED_RELATION_EDGE_TYPES].sort()).toEqual(
      ["decided_by", "has_parent", "performed_by", "superseded_by", "templated_by"].sort(),
    );
  });
});

describe("managedEdges", () => {
  it("projects a Decision's decided_by + superseded_by, but NOT its intent_ids/rules_consulted", () => {
    const edges = managedEdges({
      id: D,
      doco_id: "doco_01KSJ000000000000000000000",
      node_type: "decision",
      decision: "Pick the payment path",
      question: "Which path?",
      chosen: "Route to matching action.",
      decided_by: PRINCIPAL,
      decided_at: "2026-05-26T00:00:00.000Z",
      superseded_by: D_OLD,
      intent_ids: [INTENT],
      rules_consulted: [RULE],
    } as unknown as Entity);

    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from_id: D, to_id: PRINCIPAL, edge_type: "decided_by" }),
        expect.objectContaining({ from_id: D, to_id: D_OLD, edge_type: "superseded_by" }),
      ]),
    );
    // intent_ids → serves and rules_consulted → consults are NOT managed here.
    expect(edges.map((e) => e.edge_type).sort()).toEqual(["decided_by", "superseded_by"]);
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

    // actor_id → performed_by is managed; target → acts_on and triggered_by are
    // Tier-2 (not among the five columns) so they are NOT authored in Stage 1.
    expect(edges).toEqual([
      expect.objectContaining({ from_id: ACTION, to_id: PRINCIPAL, edge_type: "performed_by" }),
    ]);
    for (const e of edges) expect(allowed.has(e.edge_type)).toBe(true);
  });
});
