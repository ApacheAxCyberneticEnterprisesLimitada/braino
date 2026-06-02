import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { upsertEntity } from "../repo.js";
import type { EntityRecord } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

const DOCO = "doco_test0000000000000000000000";
const ORG = "workspace_test000000000000000";
const DECISION = "decision_test0000000000000000000";
const INTENT = "intent_test000000000000000000000";
const ACTION = "action_test00000000000000000000";

let db: PGlite;

function decisionRecord(): EntityRecord {
  return {
    id: DECISION,
    doco_id: DOCO,
    entity_type: "decision",
    data: {
      id: DECISION,
      doco_id: DOCO,
      node_type: "decision",
      decision: "Pick the path",
      question: "Which path?",
      chosen: "Route to the action.",
      decided_by: "principal_test000000000000000000",
      intent_ids: [INTENT],
      sequence_to: [{ target: ACTION, label: "next" }],
      lifecycle: "asserted",
    },
    type_named_value: "Pick the path",
    lifecycle: "asserted",
  } as unknown as EntityRecord;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(schemaSql);
  await db.query("INSERT INTO workspaces (id, handle, name, data) VALUES ($1,$2,$3,'{}'::jsonb)", [
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
  it("strips graph-link fields from stored node data", async () => {
    await upsertEntity(decisionRecord(), db as never);

    const { rows } = await db.query<{ data: Record<string, unknown> }>(
      "SELECT data FROM nodes WHERE id = $1",
      [DECISION],
    );
    expect(rows[0].data).not.toHaveProperty("decided_by");
    expect(rows[0].data).not.toHaveProperty("intent_ids");
    expect(rows[0].data).not.toHaveProperty("sequence_to");
  });
});
