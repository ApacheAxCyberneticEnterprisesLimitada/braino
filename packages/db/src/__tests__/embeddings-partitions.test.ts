// Embedding metadata remains partitioned by collection for cheap collection
// deletion, but vector similarity belongs only to Qdrant.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

let db: PGlite;

async function addCollections(...ids: string[]) {
  await db.query(
    `INSERT INTO collections (id, handle, owner_id, workspace_id, data)
     SELECT id, id, 'ws', 'ws', '{}' FROM unnest($1::text[]) AS id`,
    [ids],
  );
}

async function partitions(): Promise<string[]> {
  return (
    await db.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'embeddings'::regclass ORDER BY 1`,
    )
  ).rows.map((row) => row.name);
}

beforeEach(async () => {
  db = await freshDb();
  await db.query("INSERT INTO workspaces (id, handle, name) VALUES ('ws', 'ws', 'WS')");
});

describe("embedding metadata partitions", () => {
  it("creates and removes one plain-Postgres partition per collection", async () => {
    await addCollections("collection_a", "collection_b", "collection_c");
    expect(await partitions()).toEqual([
      "embeddings_collection_a",
      "embeddings_collection_b",
      "embeddings_collection_c",
    ]);

    await db.query(
      `INSERT INTO embeddings
         (collection_id, source, entity_id, chunk_index, model_id, content_hash, chunk_text, embedding)
       VALUES ('collection_b', 'node', 'decision_2', 0, 'm', 'h', 'text', $1::real[])`,
      ["{0,1,0}"],
    );
    await db.query("DELETE FROM collections WHERE id IN ('collection_a', 'collection_c')");

    expect(await partitions()).toEqual(["embeddings_collection_b"]);
    expect((await db.query("SELECT entity_id, embedding FROM embeddings")).rows).toEqual([
      { entity_id: "decision_2", embedding: [0, 1, 0] },
    ]);
  });
});

describe("pgvector removal migration", () => {
  it("keeps embedding metadata, discards redundant vectors, and is idempotent", async () => {
    await addCollections("collection_a", "collection_b");
    await db.exec(`
      DROP TABLE embeddings CASCADE;
      DROP TABLE embedding_vector_queue;
      CREATE EXTENSION vector;
      CREATE TABLE embedding_vector_queue (
        collection_id text NOT NULL,
        entity_id text NOT NULL,
        chunk_index int NOT NULL,
        operation text NOT NULL,
        queued_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (collection_id, entity_id, chunk_index)
      );
      CREATE TABLE embeddings (
        collection_id text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        source text NOT NULL,
        entity_id text NOT NULL,
        chunk_index int NOT NULL DEFAULT 0,
        model_id text NOT NULL,
        content_hash text NOT NULL,
        chunk_text text NOT NULL,
        embedding vector(1536) NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (collection_id, entity_id, chunk_index)
      );
      INSERT INTO embeddings
        (collection_id, source, entity_id, chunk_index, model_id, content_hash, chunk_text, embedding)
      VALUES
        ('collection_a', 'node', 'decision_1', 0, 'm', 'h1', 'apple', ('[1' || repeat(',0', 1535) || ']')::vector),
        ('collection_b', 'slack', 'C1:1', 0, 'm', 'h2', 'hello', ('[0,1' || repeat(',0', 1534) || ']')::vector);
      INSERT INTO embedding_vector_queue (collection_id, entity_id, chunk_index, operation)
      VALUES ('collection_a', 'decision_1', 0, 'upsert');
    `);

    await db.exec(schemaSql);

    const rows = await db.query(
      `SELECT collection_id, source, entity_id, chunk_text, embedding
         FROM embeddings ORDER BY collection_id, entity_id`,
    );
    expect(rows.rows).toEqual([
      {
        collection_id: "collection_a",
        source: "node",
        entity_id: "decision_1",
        chunk_text: "apple",
        embedding: null,
      },
      {
        collection_id: "collection_b",
        source: "slack",
        entity_id: "C1:1",
        chunk_text: "hello",
        embedding: null,
      },
    ]);
    expect(
      (
        await db.query<{ installed: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS installed",
        )
      ).rows[0]?.installed,
    ).toBe(false);
    expect(await partitions()).toEqual(["embeddings_collection_a", "embeddings_collection_b"]);
    const pending = await db.query<{ source: string; embedding: number[] }>(
      "SELECT source, embedding FROM embedding_vector_queue WHERE entity_id = 'decision_1'",
    );
    expect(pending.rows[0]?.source).toBe("node");
    expect(pending.rows[0]?.embedding.slice(0, 2)).toEqual([1, 0]);

    await db.exec(schemaSql);
    expect(
      (await db.query("SELECT collection_id, entity_id, embedding FROM embeddings ORDER BY 1, 2"))
        .rows,
    ).toEqual([
      { collection_id: "collection_a", entity_id: "decision_1", embedding: null },
      { collection_id: "collection_b", entity_id: "C1:1", embedding: null },
    ]);
  });
});
