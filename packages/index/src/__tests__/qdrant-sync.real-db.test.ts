import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import { vectorLiteral } from "../../../db/src/embeddings.js";
import { syncQueuedEmbeddings } from "../qdrant-sync.js";
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
  await db.exec("SET doco.vector_sync = 'on'");
  await db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('ws', 'ws', 'WS');
    INSERT INTO collections (id, handle, owner_id, workspace_id, data)
      VALUES ('collection_1', 'd', 'ws', 'ws', '{}'::jsonb);
  `);
});

describe("Qdrant embedding queue sync", () => {
  it("mirrors the current chunk and acknowledges its queue row", async () => {
    await db.query(
      `INSERT INTO embeddings
         (collection_id, source, entity_id, chunk_index, model_id, content_hash, chunk_text, embedding)
       VALUES ('collection_1', 'node', 'decision_1', 0, 'm', 'h', 'Ship it', $1::vector)`,
      [vectorLiteral([1, 0])],
    );
    const target = store();

    await expect(syncQueuedEmbeddings(db, target, { batchSize: 10 })).resolves.toEqual({
      processed: 1,
      upserted: 1,
      deleted: 0,
      collectionsDeleted: 0,
      exhausted: true,
    });
    expect(target.upsert).toHaveBeenCalledWith([
      expect.objectContaining({
        collection_id: "collection_1",
        source: "node",
        entity_id: "decision_1",
        chunk_index: 0,
        model_id: "m",
        content_hash: "h",
        chunk_text: "Ship it",
      }),
    ]);
    expect(
      (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM embedding_vector_queue"))
        .rows[0]?.n,
    ).toBe(0);
  });

  it("mirrors chunk and collection deletion", async () => {
    await db.query(
      `INSERT INTO embeddings
         (collection_id, source, entity_id, chunk_index, model_id, content_hash, chunk_text, embedding)
       VALUES ('collection_1', 'node', 'decision_1', 0, 'm', 'h', 'Ship it', $1::vector)`,
      [vectorLiteral([1, 0])],
    );
    await db.query("DELETE FROM embedding_vector_queue");
    await db.query(
      "DELETE FROM embeddings WHERE collection_id = 'collection_1' AND entity_id = 'decision_1'",
    );
    const chunks = store();
    await syncQueuedEmbeddings(db, chunks, { batchSize: 10 });
    expect(chunks.deletePoints).toHaveBeenCalledWith([
      { collection_id: "collection_1", entity_id: "decision_1", chunk_index: 0 },
    ]);

    await db.query("DELETE FROM collections WHERE id = 'collection_1'");
    const collections = store();
    await syncQueuedEmbeddings(db, collections, { batchSize: 10 });
    expect(collections.delete).toHaveBeenCalledWith({ collectionIds: ["collection_1"] });
  });
});
