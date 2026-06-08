import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "./fresh-db.js";

// Exercise the REAL repo functions against the REAL schema by pointing
// withClient at an in-process PGlite (its .query matches pg's PoolClient).
const mocks = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));
vi.mock("../client.js", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn(mocks.db),
}));

import {
  getDocoByHandle,
  getDocoByIdOrHandle,
  listDocoIdsForUser,
  markDocoDeleted,
  purgeDocosDeletedBefore,
  upsertDocoUser,
} from "../repo.js";

const ORG = "workspace_test000000000000000";
const DOCO = "doco_test0000000000000000000000";
const DOCO_TWO = "doco_test200000000000000000000";
const USER = "user_test00000000000000000000";

let db: PGlite;

async function seedDocoWithHistory(docoId = DOCO, handle = "doco-test"): Promise<void> {
  await db.query(
    "INSERT INTO workspaces (id, handle, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    [ORG, "workspace-test", "Workspace Test"],
  );
  await db.query(
    "INSERT INTO users (id, github_login, data) VALUES ($1, $2, '{}') ON CONFLICT DO NOTHING",
    [USER, "tester"],
  );
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
    [`decision_${docoId}`, txId],
  );
  await db.query(
    `INSERT INTO edge_versions
       (entity_id, entity_type, version, op, payload, tx_id, actor, prev_hash, this_hash)
     VALUES ($1, 'edge', 1, 'create', '{"id":"edge"}'::jsonb, $2, NULL, NULL, 'hash-edge')`,
    [`edge_${docoId}`, txId],
  );
}

async function rowCount(table: string): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table}`,
  );
  return Number(rows[0].count);
}

describe("soft-deleting a doco", () => {
  beforeEach(async () => {
    db = await freshDb();
    mocks.db = db;
    await seedDocoWithHistory();
    await upsertDocoUser({ doco_id: DOCO, user_id: USER, role: "owner" });
  });

  it("hides the doco from resolution but retains the row and its history", async () => {
    const marked = await markDocoDeleted({ docoId: DOCO });
    // The original name is freed on delete by stamping the deletion timestamp
    // onto the tombstoned handle.
    expect(marked?.handle).toMatch(/^doco-test-deleted-\d+$/);

    // Gone from every resolution path…
    expect(await getDocoByIdOrHandle(DOCO)).toBeNull();
    expect(await getDocoByIdOrHandle("doco-test")).toBeNull();
    expect(await getDocoByHandle("doco-test")).toBeNull();

    // …and from the member's listing…
    expect(await listDocoIdsForUser(USER)).not.toContain(DOCO);

    // …but the data is still there, just tombstoned under its timestamped
    // handle, and the history is intact.
    const raw = await db.query<{ handle: string; deleted_at: string | null }>(
      "SELECT handle, deleted_at FROM docos WHERE id = $1",
      [DOCO],
    );
    expect(raw.rows[0]?.deleted_at).not.toBeNull();
    expect(raw.rows[0]?.handle).toMatch(/^doco-test-deleted-\d+$/);
    expect(await rowCount("node_versions")).toBe(1);
    expect(await rowCount("edge_versions")).toBe(1);
  });

  it("is idempotent — a second soft-delete is a no-op", async () => {
    expect(await markDocoDeleted({ docoId: DOCO })).not.toBeNull();
    expect(await markDocoDeleted({ docoId: DOCO })).toBeNull();
  });

  it("frees the original handle immediately so a new doco can take it", async () => {
    const marked = await markDocoDeleted({ docoId: DOCO });
    // The tombstone carries a timestamped handle, not the original name…
    expect(marked?.handle).toMatch(/^doco-test-deleted-\d+$/);
    // …so the original name is available right away for a brand-new doco.
    await db.query(
      "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ($1,$2,$3,$4,'{}')",
      ["doco_other00000000000000000000", "doco-test", ORG, ORG],
    );
    expect(await getDocoByHandle("doco-test")).not.toBeNull();
  });
});

describe("purging tombstoned docos after the grace period", () => {
  beforeEach(async () => {
    db = await freshDb();
    mocks.db = db;
    await seedDocoWithHistory();
  });

  it("leaves a freshly-deleted doco alone until the cutoff passes", async () => {
    await markDocoDeleted({ docoId: DOCO });
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const purged = await purgeDocosDeletedBefore(thirtyDaysAgo);

    expect(purged).toHaveLength(0);
    expect(await rowCount("docos")).toBe(1);
  });

  it("hard-deletes a doco tombstoned before the cutoff, cascading its history", async () => {
    await markDocoDeleted({ docoId: DOCO });
    // Backdate the tombstone to 31 days ago.
    await db.query("UPDATE docos SET deleted_at = now() - interval '31 days' WHERE id = $1", [
      DOCO,
    ]);

    const purged = await purgeDocosDeletedBefore(new Date());

    // Keyed by id — the handle now carries the deletion timestamp.
    expect(purged.map((p) => p.id)).toEqual([DOCO]);
    for (const table of ["docos", "changesets", "node_versions", "edge_versions"]) {
      expect(await rowCount(table), table).toBe(0);
    }
  });

  it("never touches a doco that was never deleted", async () => {
    await seedDocoWithHistory(DOCO_TWO, "doco-test-two");
    await markDocoDeleted({ docoId: DOCO });
    await db.query("UPDATE docos SET deleted_at = now() - interval '31 days' WHERE id = $1", [
      DOCO,
    ]);

    const purged = await purgeDocosDeletedBefore(new Date());

    expect(purged.map((p) => p.id)).toEqual([DOCO]);
    expect(await getDocoByHandle("doco-test-two")).not.toBeNull();
  });
});
