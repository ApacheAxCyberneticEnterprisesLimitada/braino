import { describe, expect, it } from "vitest";
import { type Edge, type ExistingManagedEdge, reconcileManagedEdges } from "../edges.js";

// reconcileManagedEdges diffs the edges a node *should* project (from
// managedEdges) against the live managed-type edges already in the DB, and
// returns the create/retire plan the capture path executes in one txn.
//
// Invariants:
//  - idempotent: re-capturing identical data is a no-op (nothing created or
//    retired), so a full backfill/reindex doesn't churn edge history.
//  - 'field' edges no longer projected are retired.
//  - 'authored' edges (created directly via the edges API) are NEVER auto-
//    retired; they only satisfy a desired field edge when their role props
//    match the managed field.

const FROM = "decision_01KSJ000000000000000000000";
const P1 = "principal_01KSJ000000000000000000001";
const P2 = "principal_01KSJ000000000000000000002";
const D_OLD = "decision_01KSJ000000000000000000003";

function desired(edge_type: string, to_id: string, source_field: string, role: string): Edge {
  return {
    from_id: FROM,
    from_node_type: "decision",
    to_id,
    to_node_type: to_id.slice(0, to_id.indexOf("_")),
    edge_type,
    edge_props: { source_field, role },
  };
}

function existing(
  id: string,
  edge_type: string,
  to_id: string,
  origin: "authored" | "field",
  edge_props?: Record<string, unknown> | null,
): ExistingManagedEdge {
  return { id, edge_type, to_id, origin, edge_props };
}

const decidedBy = (toId: string) => desired("attributed_to", toId, "decided_by", "decided_by");
const replacedBy = (toId: string) => desired("replaces", toId, "superseded_by", "superseded_by");
const decidedByProps = { source_field: "decided_by", role: "decided_by" };
const supersededByProps = { source_field: "superseded_by", role: "superseded_by" };

describe("reconcileManagedEdges", () => {
  it("creates all desired edges when none exist", () => {
    const plan = reconcileManagedEdges([decidedBy(P1), replacedBy(D_OLD)], []);
    expect(plan.toCreate.map((e) => e.edge_type).sort()).toEqual(["attributed_to", "replaces"]);
    expect(plan.toRetireIds).toEqual([]);
  });

  it("is a no-op when the live field edges already match (idempotent)", () => {
    const plan = reconcileManagedEdges(
      [decidedBy(P1)],
      [existing("edge_a", "attributed_to", P1, "field", decidedByProps)],
    );
    expect(plan.toCreate).toEqual([]);
    expect(plan.toRetireIds).toEqual([]);
  });

  it("retires a field edge whose target changed and creates the new one", () => {
    const plan = reconcileManagedEdges(
      [decidedBy(P2)],
      [existing("edge_old", "attributed_to", P1, "field", decidedByProps)],
    );
    expect(plan.toCreate).toEqual([
      expect.objectContaining({ edge_type: "attributed_to", to_id: P2 }),
    ]);
    expect(plan.toRetireIds).toEqual(["edge_old"]);
  });

  it("retires field edges that are no longer projected at all", () => {
    const plan = reconcileManagedEdges(
      [],
      [
        existing("edge_a", "attributed_to", P1, "field", decidedByProps),
        existing("edge_b", "replaces", D_OLD, "field", supersededByProps),
      ],
    );
    expect(plan.toCreate).toEqual([]);
    expect(plan.toRetireIds.sort()).toEqual(["edge_a", "edge_b"]);
  });

  it("does not duplicate over an authored edge with matching role props", () => {
    const plan = reconcileManagedEdges(
      [decidedBy(P1)],
      [existing("edge_authored", "attributed_to", P1, "authored", decidedByProps)],
    );
    // already live as authored with the same role identity.
    expect(plan.toCreate).toEqual([]);
    expect(plan.toRetireIds).toEqual([]);
  });

  it("keeps authored edges while reconciling field edges around them", () => {
    const plan = reconcileManagedEdges(
      [decidedBy(P1)],
      [
        existing("edge_authored", "attributed_to", P1, "authored"),
        existing("edge_stale_field", "replaces", D_OLD, "field", supersededByProps),
      ],
    );
    expect(plan.toCreate).toEqual([
      expect.objectContaining({ edge_type: "attributed_to", to_id: P1 }),
    ]);
    expect(plan.toRetireIds).toEqual(["edge_stale_field"]);
  });
});
