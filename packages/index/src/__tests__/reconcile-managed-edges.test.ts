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
//    retired, and a desired edge that already exists as 'authored' is not
//    duplicated (the live-unique index would reject it anyway).

const FROM = "decision_01KSJ000000000000000000000";
const P1 = "principal_01KSJ000000000000000000001";
const P2 = "principal_01KSJ000000000000000000002";
const D_OLD = "decision_01KSJ000000000000000000003";

function desired(edge_type: string, to_id: string): Edge {
  return {
    from_id: FROM,
    from_node_type: "decision",
    to_id,
    to_node_type: to_id.slice(0, to_id.indexOf("_")),
    edge_type,
  };
}

function existing(
  id: string,
  edge_type: string,
  to_id: string,
  origin: "authored" | "field",
): ExistingManagedEdge {
  return { id, edge_type, to_id, origin };
}

describe("reconcileManagedEdges", () => {
  it("creates all desired edges when none exist", () => {
    const plan = reconcileManagedEdges(
      [desired("decided_by", P1), desired("superseded_by", D_OLD)],
      [],
    );
    expect(plan.toCreate.map((e) => e.edge_type).sort()).toEqual(["decided_by", "superseded_by"]);
    expect(plan.toRetireIds).toEqual([]);
  });

  it("is a no-op when the live field edges already match (idempotent)", () => {
    const plan = reconcileManagedEdges(
      [desired("decided_by", P1)],
      [existing("edge_a", "decided_by", P1, "field")],
    );
    expect(plan.toCreate).toEqual([]);
    expect(plan.toRetireIds).toEqual([]);
  });

  it("retires a field edge whose target changed and creates the new one", () => {
    const plan = reconcileManagedEdges(
      [desired("decided_by", P2)],
      [existing("edge_old", "decided_by", P1, "field")],
    );
    expect(plan.toCreate).toEqual([
      expect.objectContaining({ edge_type: "decided_by", to_id: P2 }),
    ]);
    expect(plan.toRetireIds).toEqual(["edge_old"]);
  });

  it("retires field edges that are no longer projected at all", () => {
    const plan = reconcileManagedEdges(
      [],
      [
        existing("edge_a", "decided_by", P1, "field"),
        existing("edge_b", "superseded_by", D_OLD, "field"),
      ],
    );
    expect(plan.toCreate).toEqual([]);
    expect(plan.toRetireIds.sort()).toEqual(["edge_a", "edge_b"]);
  });

  it("never retires an authored edge, and does not duplicate over one", () => {
    const plan = reconcileManagedEdges(
      [desired("decided_by", P1)],
      [existing("edge_authored", "decided_by", P1, "authored")],
    );
    // already live as authored → don't create a duplicate (unique index), and
    // never retire an authored edge.
    expect(plan.toCreate).toEqual([]);
    expect(plan.toRetireIds).toEqual([]);
  });

  it("keeps authored edges while reconciling field edges around them", () => {
    const plan = reconcileManagedEdges(
      [desired("decided_by", P1)],
      [
        existing("edge_authored", "decided_by", P1, "authored"),
        existing("edge_stale_field", "superseded_by", D_OLD, "field"),
      ],
    );
    expect(plan.toCreate).toEqual([]);
    expect(plan.toRetireIds).toEqual(["edge_stale_field"]);
  });
});
