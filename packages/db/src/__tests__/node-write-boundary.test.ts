import { describe, expect, it } from "vitest";
import { nodeRowFromFields } from "../repo.js";

// `nodeRowFromFields` is the ONE write boundary that turns a captured field bag
// into the honest `NodeRow` the writer stores — the symmetric counterpart of
// `rowToNode` on read. These pin the split: `prose` is the text, the promoted
// scalars become their columns, every other domain field lands in `extra`, and
// identity/audit map straight across.

describe("nodeRowFromFields — the write split into a NodeRow", () => {
  it("routes prose, promoted columns, and domain fields to the right slots", () => {
    const node = nodeRowFromFields("reference", {
      id: "reference_01ABCDEFGHJKMNPQRSTVWXYZ00",
      doco_id: "doco_01",
      node_type: "reference", // ignored — the explicit nodeType arg wins
      prose: "ACME PR #1",
      locator: "https://example.com/pr/1", // promoted column
      definition: "a glossary meaning", // domain field -> extra
      pr_body: "the body", // domain field -> extra
      lifecycle: "active",
      created_at: "2026-01-02T03:04:05.000Z",
      created_by: "user_01",
    });
    expect(node).toMatchObject({
      id: "reference_01ABCDEFGHJKMNPQRSTVWXYZ00",
      doco_id: "doco_01",
      node_type: "reference",
      prose: "ACME PR #1",
      locator: "https://example.com/pr/1",
      lifecycle: "active",
      created_at: "2026-01-02T03:04:05.000Z",
      created_by: "user_01",
    });
    // The promoted column is NOT duplicated into extra; the domain fields are.
    expect(node.extra).toEqual({ definition: "a glossary meaning", pr_body: "the body" });
    expect(node.kind).toBeNull();
    expect(node.proposer_id).toBeNull();
  });

  it("promotes only the columns the node type carries; reserved keys never hit extra", () => {
    // `kind` is promoted for eval/state/principal -> its column, never extra.
    const evalNode = nodeRowFromFields("eval", { id: "eval_01", doco_id: "d", kind: "unit" });
    expect(evalNode.kind).toBe("unit");
    expect(evalNode.extra).not.toHaveProperty("kind");

    // intent promotes nothing: a reserved `locator` is dropped (it has no column
    // and is excluded from extra), while a real domain field is kept.
    const intent = nodeRowFromFields("intent", {
      id: "intent_01",
      doco_id: "d",
      locator: "x",
      priority: "p1",
    });
    expect(intent.locator).toBeNull();
    expect(intent.extra).toEqual({ priority: "p1" });
  });

  it("excludes identity/audit/legacy keys from extra", () => {
    const node = nodeRowFromFields("decision", {
      id: "decision_01",
      doco_id: "d",
      node_type: "decision",
      prose: "Pick A",
      lifecycle: "active",
      created_at: "t",
      name: "stale alias", // legacy prose alias — dropped
      chosen: "A", // domain -> extra
    });
    expect(node.extra).toEqual({ chosen: "A" });
  });
});
