import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { type NodeRow, nodeRowFromFields, upsertNode } from "../repo.js";
import { freshDb } from "./fresh-db.js";

const DOCO = "doco_test0000000000000000000000";
const ORG = "workspace_test000000000000000";
const DECISION = "decision_test0000000000000000000";
const INTENT = "intent_test000000000000000000000";
const ACTION = "action_test00000000000000000000";

let db: PGlite;

function decisionRecord(): NodeRow {
  return nodeRowFromFields("decision", {
    id: DECISION,
    doco_id: DOCO,
    node_type: "decision",
    prose: "Pick the path",
    question: "Which path?",
    chosen: "Route to the action.",
    decided_by: "principal_test000000000000000000",
    intent_ids: [INTENT],
    sequence_to: [{ target: ACTION, label: "next" }],
    lifecycle: "active",
  });
}

beforeAll(async () => {
  db = await freshDb();
  await db.query("INSERT INTO workspaces (id, handle, name) VALUES ($1, $2, $3)", [
    ORG,
    "workspace-test",
    "Workspace Test",
  ]);
  await db.query(
    "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ($1,$2,$3,$4,'{}'::jsonb)",
    [DOCO, "doco-test", ORG, ORG],
  );
});

describe("node edge JSON storage", () => {
  it("strips graph-link fields from the stored node extra bag", async () => {
    await upsertNode(decisionRecord(), db as never);

    // Slim-down: the catch-all `data` jsonb is gone; per-node fields persist in
    // `extra`. Graph-link fields belong in `edges`, so they must never
    // leak into the extra bag.
    const { rows } = await db.query<{ extra: Record<string, unknown> }>(
      "SELECT extra FROM nodes WHERE id = $1",
      [DECISION],
    );
    expect(rows[0].extra).not.toHaveProperty("decided_by");
    expect(rows[0].extra).not.toHaveProperty("intent_ids");
    expect(rows[0].extra).not.toHaveProperty("sequence_to");
    // The non-link domain field still rides along.
    expect(rows[0].extra).toMatchObject({ question: "Which path?" });
  });
});
