import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";

const ORG = "workspace_test000000000000000";
const DOCO = "doco_test0000000000000000000000";
const DOCO_TWO = "doco_test200000000000000000000";
const NODE = "decision_test0000000000000000000";
const NODE_TWO = "decision_test200000000000000000";
const EDGE = "edge_test000000000000000000000";
const EDGE_TWO = "edge_test20000000000000000000";

let db: PGlite;

async function seedWorkspace(): Promise<void> {
  await db.query(
    "INSERT INTO workspaces (id, handle, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    [ORG, "workspace-test", "Workspace Test"],
  );
}

async function seedDocoWithHistory(
  docoId = DOCO,
  handle = "doco-test",
  nodeId = NODE,
  edgeId = EDGE,
): Promise<void> {
  await seedWorkspace();
  await db.query(
    "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ($1,$2,$3,$4,'{}')",
    [docoId, handle, ORG, ORG],
  );
  const changeset = await db.query<{ tx_id: string }>(
    `INSERT INTO changesets (doco_id, actor, source, reason, metadata)
     VALUES ($1, NULL, 'api', 'seed history', '{}'::jsonb)
     RETURNING tx_id`,
    [docoId],
  );
  const txId = changeset.rows[0].tx_id;
  await db.query(
    `INSERT INTO node_versions
       (entity_id, entity_type, version, op, payload, tx_id, actor, prev_hash, this_hash)
     VALUES ($1, 'decision', 1, 'create', '{"id":"decision"}'::jsonb, $2, NULL, NULL, 'hash-node')`,
    [nodeId, txId],
  );
  await db.query(
    `INSERT INTO edge_versions
       (entity_id, entity_type, version, op, payload, tx_id, actor, prev_hash, this_hash)
     VALUES ($1, 'edge', 1, 'create', '{"id":"edge"}'::jsonb, $2, NULL, NULL, 'hash-edge')`,
    [edgeId, txId],
  );
}

describe("deleting docos with append-only history", () => {
  beforeEach(async () => {
    db = await freshDb();
    await seedDocoWithHistory();
  });

  it("keeps direct history deletion blocked", async () => {
    await expect(
      db.query("DELETE FROM node_versions WHERE entity_id = $1", [NODE]),
    ).rejects.toThrow(/history append-only/i);
  });

  it("allows a parent doco delete to clean up its history rows", async () => {
    await db.query("DELETE FROM docos WHERE id = $1", [DOCO]);

    for (const table of ["docos", "changesets", "node_versions", "edge_versions"]) {
      const { rows } = await db.query<{ count: string }>(`SELECT COUNT(*)::text FROM ${table}`);
      expect(rows[0].count, table).toBe("0");
    }
  });

  it("does not leave manual history deletes open in the same transaction", async () => {
    await seedDocoWithHistory(DOCO_TWO, "doco-test-two", NODE_TWO, EDGE_TWO);
    await db.query("BEGIN");
    await db.query("DELETE FROM docos WHERE id = $1", [DOCO]);

    await expect(
      db.query("DELETE FROM node_versions WHERE entity_id = $1", [NODE_TWO]),
    ).rejects.toThrow(/history append-only/i);

    await db.query("ROLLBACK").catch(() => undefined);
  });
});
