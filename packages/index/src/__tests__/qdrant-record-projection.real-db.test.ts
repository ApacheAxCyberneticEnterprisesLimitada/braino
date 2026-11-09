import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import {
  resetNodeSearchProjection,
  syncNodeSearchProjection,
} from "../qdrant-record-projection.js";
import type { VectorStore } from "../qdrant-vector-store.js";

let db: PGlite;

function store() {
  return {
    upsert: vi.fn(async () => undefined),
    deletePoints: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    rank: vi.fn(async () => []),
  } satisfies VectorStore;
}

beforeEach(async () => {
  db = await freshDb();
  await db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('ws', 'ws', 'WS');
    INSERT INTO collections (id, handle, owner_id, workspace_id, data)
      VALUES ('collection_1', 'docs', 'ws', 'ws', '{}'::jsonb);
    INSERT INTO nodes (id, collection_id, node_type, prose, locator, extra)
      VALUES (
        'reference_1', 'collection_1', 'reference',
        'Use the Aurora runbook during database incidents.',
        'https://example.test/aurora',
        '{"title":"Incident response handbook"}'::jsonb
      );
    DELETE FROM qdrant_record_queue;
  `);
});

describe("Qdrant record projection", () => {
  it("backfills existing nodes and records enough text for lexical search", async () => {
    const target = store();

    await expect(syncNodeSearchProjection(db, target, { batchSize: 10 })).resolves.toEqual({
      processed: 1,
      upserted: 1,
      deleted: 0,
      phase: "backfill",
      exhausted: true,
    });
    expect(target.upsert).toHaveBeenCalledWith([
      expect.objectContaining({
        collection_id: "collection_1",
        source: "node",
        entity_id: "reference_1",
        chunk_index: 0,
        model_id: "doco:record-search:v1",
        chunk_text: expect.stringContaining("Incident response handbook"),
        embedding: [1],
      }),
    ]);
    expect(target.upsert.mock.calls[0]?.[0]?.[0]?.chunk_text).toContain("Aurora runbook");
    expect(target.upsert.mock.calls[0]?.[0]?.[0]?.chunk_text).toContain(
      "https://example.test/aurora",
    );
  });

  it("retries current updates and deletions through a durable outbox", async () => {
    await syncNodeSearchProjection(db, store(), { batchSize: 10 });
    await db.query(
      `UPDATE nodes SET prose = 'Use the Borealis runbook.', updated_at = now()
        WHERE id = 'reference_1'`,
    );
    const updated = store();

    await expect(syncNodeSearchProjection(db, updated, { batchSize: 10 })).resolves.toMatchObject({
      processed: 1,
      upserted: 1,
      deleted: 0,
      phase: "queue",
    });
    expect(updated.upsert.mock.calls[0]?.[0]?.[0]?.chunk_text).toContain("Borealis runbook");
    expect(
      (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM qdrant_record_queue")).rows[0]
        ?.n,
    ).toBe(0);

    await db.query("DELETE FROM nodes WHERE id = 'reference_1'");
    const deleted = store();
    await expect(syncNodeSearchProjection(db, deleted, { batchSize: 10 })).resolves.toMatchObject({
      processed: 1,
      upserted: 0,
      deleted: 1,
      phase: "queue",
    });
    expect(deleted.deletePoints).toHaveBeenCalledWith([
      { collection_id: "collection_1", entity_id: "reference_1", chunk_index: 0 },
    ]);
  });

  it("keeps the outbox row when Qdrant rejects a write", async () => {
    await syncNodeSearchProjection(db, store(), { batchSize: 10 });
    await db.query("UPDATE nodes SET prose = 'Retry me' WHERE id = 'reference_1'");
    const target = store();
    target.upsert.mockRejectedValueOnce(new Error("Qdrant unavailable"));

    await expect(syncNodeSearchProjection(db, target, { batchSize: 10 })).rejects.toThrow(
      "Qdrant unavailable",
    );
    expect(
      (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM qdrant_record_queue")).rows[0]
        ?.n,
    ).toBe(1);
  });

  it("restarts the backfill when the derived Qdrant collection is recreated", async () => {
    await syncNodeSearchProjection(db, store(), { batchSize: 10 });
    await db.query("UPDATE nodes SET prose = 'Current PostgreSQL value' WHERE id = 'reference_1'");

    await resetNodeSearchProjection(db);
    const rebuilt = store();
    await expect(syncNodeSearchProjection(db, rebuilt, { batchSize: 10 })).resolves.toMatchObject({
      phase: "backfill",
      processed: 1,
      upserted: 1,
      exhausted: true,
    });
    expect(rebuilt.upsert.mock.calls[0]?.[0]?.[0]?.chunk_text).toContain(
      "Current PostgreSQL value",
    );
    expect(
      (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM qdrant_record_queue")).rows[0]
        ?.n,
    ).toBe(0);
  });
});
