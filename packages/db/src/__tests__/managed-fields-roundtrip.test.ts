// End-to-end proof (against a real Postgres engine, PGlite) that the managed
// node→node relationship fields round-trip through edges (option (i)):
//   - upsertEntity STRIPS the field from stored `data` (the edge is the truth)
//   - hydrateManagedRelations RECONSTRUCTS it from the edge on read
//
// This is the one live-DB test in the package; the rest are SQL-string/unit
// assertions (no Postgres in CI). PGlite gives us a genuine PG to exercise the
// strip + hydrate SQL the API / MCP / web / perspectives all rely on.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { hydrateManagedRelations, upsertEntity } from "../repo.js";
import type { EntityRecord } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

const DOCO = "doco_test0000000000000000000000";
const ORG = "organization_test000000000000000";
const DECISION = "decision_test0000000000000000000";
const PRINCIPAL = "principal_test000000000000000000";
const ACTION = "action_test00000000000000000000";

// PGlite's client is duck-compatible with the pg.PoolClient the repo helpers
// expect (both expose `query(sql, params) -> { rows }`).
type PgLike = Parameters<typeof hydrateManagedRelations>[0];

let db: PGlite;

function decisionRecord(decidedBy: string): EntityRecord {
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
      decided_by: decidedBy,
      decided_at: "2026-05-26T00:00:00.000Z",
      lifecycle: "asserted",
    },
    type_named_value: "Pick the path",
    lifecycle: "asserted",
    created_at: "2026-05-26T00:00:00.000Z",
    created_by: "user_test0000000000000000000000",
    updated_at: "2026-05-26T00:00:00.000Z",
    updated_by: "user_test0000000000000000000000",
  } as unknown as EntityRecord;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(schemaSql);
  // Minimal containment so the nodes/edges FKs resolve.
  await db.query(
    "INSERT INTO organizations (id, handle, name, data) VALUES ($1,$2,$3,'{}'::jsonb)",
    [ORG, "org-test", "Org Test"],
  );
  await db.query(
    "INSERT INTO docos (id, handle, owner_id, org_id, data) VALUES ($1,$2,$3,$4,'{}'::jsonb)",
    [DOCO, "doco-test", ORG, ORG],
  );
  // The decided_by target must exist as a node (edges.to_id → nodes(id)).
  await upsertEntity(
    {
      id: PRINCIPAL,
      doco_id: DOCO,
      entity_type: "principal",
      data: {
        id: PRINCIPAL,
        doco_id: DOCO,
        node_type: "principal",
        name: "Decider",
        role_principal: true,
      },
      name: "Decider",
    } as unknown as EntityRecord,
    db as unknown as PgLike,
  );
});

describe("managed relationship fields round-trip through edges", () => {
  it("strips decided_by from stored data on upsert (the edge is the source of truth)", async () => {
    await upsertEntity(decisionRecord(PRINCIPAL), db as unknown as PgLike);
    const { rows } = await db.query<{ data: Record<string, unknown> }>(
      "SELECT data FROM nodes WHERE id = $1",
      [DECISION],
    );
    expect(rows).toHaveLength(1);
    // The relationship value no longer lives in stored `data`…
    expect("decided_by" in rows[0].data).toBe(false);
    // …but the rest of the authored content is intact.
    expect(rows[0].data.chosen).toBe("Route to the action.");
  });

  it("reconstructs decided_by from the edge on read (hydrateManagedRelations)", async () => {
    // Author the edge the capture path would have created.
    await db.query(
      `INSERT INTO edges (id, doco_id, edge_type, from_id, from_node_type, to_id, to_node_type, origin)
       VALUES ($1,$2,'decided_by',$3,'decision',$4,'principal','field')`,
      ["edge_test00000000000000000000000", DOCO, DECISION, PRINCIPAL],
    );
    const { rows } = await db.query<{ data: Record<string, unknown> }>(
      "SELECT data FROM nodes WHERE id = $1",
      [DECISION],
    );
    const record = {
      id: DECISION,
      doco_id: DOCO,
      entity_type: "decision",
      data: rows[0].data,
    } as unknown as EntityRecord;
    expect("decided_by" in record.data).toBe(false);

    await hydrateManagedRelations(db as unknown as PgLike, "decision", [record]);

    expect(record.data.decided_by).toBe(PRINCIPAL);
  });

  it("is a no-op for a node with no managed edge", async () => {
    const record = {
      id: ACTION,
      doco_id: DOCO,
      entity_type: "action",
      data: { id: ACTION, node_type: "action" },
    } as unknown as EntityRecord;
    await hydrateManagedRelations(db as unknown as PgLike, "action", [record]);
    expect("actor_id" in record.data).toBe(false);
  });
});
