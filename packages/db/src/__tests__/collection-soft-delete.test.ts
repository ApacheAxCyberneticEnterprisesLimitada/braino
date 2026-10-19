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
  getCollectionByHandle,
  getCollectionByIdOrHandle,
  listCollectionIdsForUser,
  markCollectionDeleted,
  purgeCollectionsDeletedBefore,
  upsertCollectionUser,
} from "../repo.js";

const ORG = "workspace_test000000000000000";
const COLLECTION = "collection_test0000000000000000000000";
const COLLECTION_TWO = "collection_test200000000000000000000";
const USER = "user_test00000000000000000000";

let db: PGlite;

async function seedCollectionWithHistory(
  collectionId = COLLECTION,
  handle = "collection-test",
): Promise<void> {
  await db.query(
    "INSERT INTO workspaces (id, handle, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    [ORG, "workspace-test", "Workspace Test"],
  );
  await db.query(
    "INSERT INTO users (id, github_login, data) VALUES ($1, $2, '{}') ON CONFLICT DO NOTHING",
    [USER, "tester"],
  );
  await db.query(
    "INSERT INTO collections (id, handle, owner_id, workspace_id, data) VALUES ($1,$2,$3,$4,'{}')",
    [collectionId, handle, ORG, ORG],
  );
  const changeset = await db.query<{ tx_id: string }>(
    `INSERT INTO changesets (collection_id, actor, source, reason, metadata)
     VALUES ($1, NULL, 'api', 'seed history', '{}'::jsonb)
     RETURNING tx_id`,
    [collectionId],
  );
  const txId = changeset.rows[0].tx_id;
  await db.query(
    `INSERT INTO node_versions
       (entity_id, entity_type, version, op, payload, tx_id, actor, prev_hash, this_hash)
     VALUES ($1, 'decision', 1, 'create', '{"id":"decision"}'::jsonb, $2, NULL, NULL, 'hash-node')`,
    [`decision_${collectionId}`, txId],
  );
  await db.query(
    `INSERT INTO edge_versions
       (entity_id, entity_type, version, op, payload, tx_id, actor, prev_hash, this_hash)
     VALUES ($1, 'edge', 1, 'create', '{"id":"edge"}'::jsonb, $2, NULL, NULL, 'hash-edge')`,
    [`edge_${collectionId}`, txId],
  );
}

async function rowCount(table: string): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table}`,
  );
  return Number(rows[0].count);
}

describe("soft-deleting a collection", () => {
  beforeEach(async () => {
    db = await freshDb();
    mocks.db = db;
    await seedCollectionWithHistory();
    await upsertCollectionUser({ collection_id: COLLECTION, user_id: USER, role: "owner" });
  });

  it("hides the collection from resolution but retains the row and its history", async () => {
    const marked = await markCollectionDeleted({ collectionId: COLLECTION });
    // The original name is freed on delete by stamping the deletion timestamp
    // onto the tombstoned handle.
    expect(marked?.handle).toMatch(/^collection-test-deleted-\d+$/);

    // Gone from every resolution path…
    expect(await getCollectionByIdOrHandle(COLLECTION)).toBeNull();
    expect(await getCollectionByIdOrHandle("collection-test")).toBeNull();
    expect(await getCollectionByHandle("collection-test")).toBeNull();

    // …and from the member's listing…
    expect(await listCollectionIdsForUser(USER)).not.toContain(COLLECTION);

    // …but the data is still there, just tombstoned under its timestamped
    // handle, and the history is intact.
    const raw = await db.query<{ handle: string; deleted_at: string | null }>(
      "SELECT handle, deleted_at FROM collections WHERE id = $1",
      [COLLECTION],
    );
    expect(raw.rows[0]?.deleted_at).not.toBeNull();
    expect(raw.rows[0]?.handle).toMatch(/^collection-test-deleted-\d+$/);
    expect(await rowCount("node_versions")).toBe(1);
    expect(await rowCount("edge_versions")).toBe(1);
  });

  it("is idempotent — a second soft-delete is a no-op", async () => {
    expect(await markCollectionDeleted({ collectionId: COLLECTION })).not.toBeNull();
    expect(await markCollectionDeleted({ collectionId: COLLECTION })).toBeNull();
  });

  it("frees the original handle immediately so a new collection can take it", async () => {
    const marked = await markCollectionDeleted({ collectionId: COLLECTION });
    // The tombstone carries a timestamped handle, not the original name…
    expect(marked?.handle).toMatch(/^collection-test-deleted-\d+$/);
    // …so the original name is available right away for a brand-new collection.
    await db.query(
      "INSERT INTO collections (id, handle, owner_id, workspace_id, data) VALUES ($1,$2,$3,$4,'{}')",
      ["collection_other00000000000000000000", "collection-test", ORG, ORG],
    );
    expect(await getCollectionByHandle("collection-test")).not.toBeNull();
  });
});

describe("purging tombstoned collections after the grace period", () => {
  beforeEach(async () => {
    db = await freshDb();
    mocks.db = db;
    await seedCollectionWithHistory();
  });

  it("leaves a freshly-deleted collection alone until the cutoff passes", async () => {
    await markCollectionDeleted({ collectionId: COLLECTION });
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const purged = await purgeCollectionsDeletedBefore(thirtyDaysAgo);

    expect(purged).toHaveLength(0);
    expect(await rowCount("collections")).toBe(1);
  });

  it("hard-deletes a collection tombstoned before the cutoff, cascading its history", async () => {
    await markCollectionDeleted({ collectionId: COLLECTION });
    // Backdate the tombstone to 31 days ago.
    await db.query("UPDATE collections SET deleted_at = now() - interval '31 days' WHERE id = $1", [
      COLLECTION,
    ]);

    const purged = await purgeCollectionsDeletedBefore(new Date());

    // Keyed by id — the handle now carries the deletion timestamp.
    expect(purged.map((p) => p.id)).toEqual([COLLECTION]);
    for (const table of ["collections", "changesets", "node_versions", "edge_versions"]) {
      expect(await rowCount(table), table).toBe(0);
    }
  });

  it("never touches a collection that was never deleted", async () => {
    await seedCollectionWithHistory(COLLECTION_TWO, "collection-test-two");
    await markCollectionDeleted({ collectionId: COLLECTION });
    await db.query("UPDATE collections SET deleted_at = now() - interval '31 days' WHERE id = $1", [
      COLLECTION,
    ]);

    const purged = await purgeCollectionsDeletedBefore(new Date());

    expect(purged.map((p) => p.id)).toEqual([COLLECTION]);
    expect(await getCollectionByHandle("collection-test-two")).not.toBeNull();
  });
});
