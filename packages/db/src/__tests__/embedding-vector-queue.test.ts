import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { vectorLiteral } from "../embeddings.js";
import { freshDb } from "./fresh-db.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
  await db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('ws', 'ws', 'WS');
    INSERT INTO collections (id, handle, owner_id, workspace_id, data)
      VALUES ('collection_1', 'd', 'ws', 'ws', '{}'::jsonb);
  `);
});

async function queue() {
  return (
    await db.query<{
      collection_id: string;
      entity_id: string;
      chunk_index: number;
      operation: string;
    }>(
      `SELECT collection_id, entity_id, chunk_index, operation
         FROM embedding_vector_queue
        ORDER BY collection_id, entity_id, chunk_index`,
    )
  ).rows;
}

describe("embedding vector sync queue", () => {
  it("does not collect work when no external vector index is enabled", async () => {
    await db.query(
      `INSERT INTO embeddings
         (collection_id, source, entity_id, chunk_index, model_id, content_hash, chunk_text, embedding)
       VALUES ('collection_1', 'node', 'decision_1', 0, 'm', 'h', 'One', $1::vector)`,
      [vectorLiteral([1, 0])],
    );
    expect(await queue()).toEqual([]);
  });

  it("collects work from every database writer once the host enables its external index", async () => {
    await db.exec("UPDATE hosts SET external_vector_index_enabled = true WHERE id = 'host'");
    await db.query(
      `INSERT INTO embeddings
         (collection_id, source, entity_id, chunk_index, model_id, content_hash, chunk_text, embedding)
       VALUES ('collection_1', 'node', 'decision_1', 0, 'm', 'h', 'One', $1::vector)`,
      [vectorLiteral([1, 0])],
    );
    expect(await queue()).toEqual([
      {
        collection_id: "collection_1",
        entity_id: "decision_1",
        chunk_index: 0,
        operation: "upsert",
      },
    ]);
  });

  it("collapses each chunk to its latest upsert or delete", async () => {
    await db.exec("SET doco.vector_sync = 'on'");
    await db.query(
      `INSERT INTO embeddings
         (collection_id, source, entity_id, chunk_index, model_id, content_hash, chunk_text, embedding)
       VALUES ('collection_1', 'node', 'decision_1', 0, 'm', 'h1', 'One', $1::vector)`,
      [vectorLiteral([1, 0])],
    );
    await db.query(
      `UPDATE embeddings SET content_hash = 'h2', chunk_text = 'Two'
        WHERE collection_id = 'collection_1' AND entity_id = 'decision_1' AND chunk_index = 0`,
    );
    expect(await queue()).toEqual([
      {
        collection_id: "collection_1",
        entity_id: "decision_1",
        chunk_index: 0,
        operation: "upsert",
      },
    ]);

    await db.query(
      `DELETE FROM embeddings
        WHERE collection_id = 'collection_1' AND entity_id = 'decision_1' AND chunk_index = 0`,
    );
    expect(await queue()).toEqual([
      {
        collection_id: "collection_1",
        entity_id: "decision_1",
        chunk_index: 0,
        operation: "delete",
      },
    ]);
  });

  it("replaces pending chunk work with one collection delete", async () => {
    await db.exec("SET doco.vector_sync = 'on'");
    await db.query(
      `INSERT INTO nodes (id, collection_id, node_type, lifecycle, prose)
       VALUES ('decision_1', 'collection_1', 'decision', 'active', 'One')`,
    );
    await db.query(
      `INSERT INTO embeddings
         (collection_id, source, entity_id, chunk_index, model_id, content_hash, chunk_text, embedding)
       VALUES ('collection_1', 'node', 'decision_1', 0, 'm', 'h', 'One', $1::vector)`,
      [vectorLiteral([1, 0])],
    );
    await db.query("DELETE FROM collections WHERE id = 'collection_1'");
    expect(await queue()).toEqual([
      {
        collection_id: "collection_1",
        entity_id: "",
        chunk_index: -1,
        operation: "delete_collection",
      },
    ]);
  });
});
