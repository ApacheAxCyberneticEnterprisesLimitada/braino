// One HNSW index per collection, over half-precision 512-dimension cuts, rescored
// with the whole vector (schema.sql, `embeddings`): every collection gets its own
// partition when it is made
// and loses it when it goes; a search walks the 512-dimension index of the
// collections it asks for and orders what it finds by the full 1,536 dimensions; and
// a database still on the one-table shape moves to it without losing a row.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { rankEmbeddings, vectorLiteral } from "../embeddings.js";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

let db: PGlite;
type Client = Parameters<typeof rankEmbeddings>[0];
const client = () => db as unknown as Client;

/** A 1,536-dimension vector with the given dimensions set. */
function sparse(entries: Record<number, number>): number[] {
  const v = new Array(1536).fill(0);
  for (const [i, x] of Object.entries(entries)) v[Number(i)] = x;
  return v;
}

/** A deterministic pseudo-random unit-free vector. */
function noise(seed: number): number[] {
  let s = seed;
  return Array.from({ length: 1536 }, () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648 - 0.5;
  });
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

async function addCollections(...ids: string[]) {
  await db.query(
    `INSERT INTO collections (id, handle, owner_id, workspace_id, data)
     SELECT id, id, 'ws', 'ws', '{}' FROM unnest($1::text[]) AS id`,
    [ids],
  );
}

async function addChunks(collectionId: string, chunks: { entity: string; vector: number[] }[]) {
  await db.query(
    `INSERT INTO embeddings
       (collection_id, source, entity_id, chunk_index, model_id, content_hash, chunk_text, embedding)
     SELECT $1, 'node', e, 0, 'm', 'h', 'text of ' || e, v::vector
       FROM unnest($2::text[], $3::text[]) AS t(e, v)`,
    [collectionId, chunks.map((c) => c.entity), chunks.map((c) => vectorLiteral(c.vector))],
  );
}

async function partitions(): Promise<string[]> {
  return (
    await db.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'embeddings'::regclass ORDER BY 1`,
    )
  ).rows.map((r) => r.name);
}

beforeEach(async () => {
  db = await freshDb();
  await db.query("INSERT INTO workspaces (id, handle, name) VALUES ('ws', 'ws', 'WS')");
});

describe("a partition per collection", () => {
  it("is made with the collection, carries the 512-dimension index, and goes with it", async () => {
    await addCollections("collection_a", "collection_b");
    await addCollections("collection_c");
    expect(await partitions()).toEqual([
      "embeddings_collection_a",
      "embeddings_collection_b",
      "embeddings_collection_c",
    ]);
    const indexes = (
      await db.query<{ def: string }>(
        "SELECT indexdef AS def FROM pg_indexes WHERE tablename = 'embeddings_collection_a'",
      )
    ).rows.map((r) => r.def);
    expect(
      indexes.some((def) =>
        /USING hnsw .*subvector\(embedding, 1, 512\).*halfvec_cosine_ops.*m='32', ef_construction='200'/.test(
          def,
        ),
      ),
    ).toBe(true);

    await addChunks("collection_a", [{ entity: "decision_1", vector: sparse({ 0: 1 }) }]);
    await addChunks("collection_b", [{ entity: "decision_2", vector: sparse({ 1: 1 }) }]);
    await db.query("DELETE FROM collections WHERE id IN ('collection_a', 'collection_c')");
    expect(await partitions()).toEqual(["embeddings_collection_b"]);
    expect((await db.query("SELECT entity_id FROM embeddings")).rows).toEqual([
      { entity_id: "decision_2" },
    ]);
  });
});

describe("nearest chunks", () => {
  it("finds every chunk of a small collection next to a big one, scored on the whole vector", async () => {
    await addCollections("collection_small", "collection_big");
    const small = Array.from({ length: 18 }, (_, i) => ({
      entity: `small_${i}`,
      vector: noise(i + 1),
    }));
    await addChunks("collection_small", small);
    await addChunks(
      "collection_big",
      Array.from({ length: 150 }, (_, i) => ({ entity: `big_${i}`, vector: noise(i + 1000) })),
    );
    const query = noise(4242);
    const hits = await rankEmbeddings(client(), {
      collectionIds: ["collection_small"],
      source: "node",
      modelId: "m",
      queryEmbedding: query,
      limit: 100,
    });
    const exact = small
      .map((c) => ({ entity: c.entity, score: cosine(c.vector, query) }))
      .sort((a, b) => b.score - a.score);
    expect(hits.map((h) => h.entity_id)).toEqual(exact.map((e) => e.entity));
    hits.forEach((hit, i) => expect(hit.score).toBeCloseTo(exact[i].score, 3));
  });

  it("orders by the whole vector when its first 512 dimensions disagree", async () => {
    await addCollections("collection_a");
    // On the first 512 dimensions `prefix_wins` is the query's twin; across
    // all 1,536 `whole_wins` is closer (0.85 against 0.71).
    await addChunks("collection_a", [
      { entity: "prefix_wins", vector: sparse({ 0: 1 }) },
      { entity: "whole_wins", vector: sparse({ 0: 0.5, 1: 0.5, 600: 0.7 }) },
    ]);
    const hits = await rankEmbeddings(client(), {
      collectionIds: ["collection_a"],
      source: "node",
      modelId: "m",
      queryEmbedding: sparse({ 0: 1, 600: 1 }),
      limit: 10,
    });
    expect(hits.map((h) => h.entity_id)).toEqual(["whole_wins", "prefix_wins"]);
    expect(hits[0].score).toBeCloseTo(1.2 / (Math.SQRT2 * Math.sqrt(0.99)), 3);
    expect(hits[1].score).toBeCloseTo(Math.SQRT1_2, 3);
  });

  it("widens the walk for the search alone, not for the rest of the session", async () => {
    await addCollections("collection_a");
    await addChunks("collection_a", [{ entity: "decision_1", vector: sparse({ 0: 1 }) }]);
    await db.query("SET hnsw.ef_search = 40");
    const hits = await rankEmbeddings(client(), {
      collectionIds: ["collection_a", "collection_missing"],
      source: "node",
      modelId: "m",
      queryEmbedding: sparse({ 0: 1 }),
      limit: 100,
    });
    expect(hits.map((h) => h.entity_id)).toEqual(["decision_1"]);
    const settings = await db.query<{ ef: string; scan: string }>(
      "SELECT current_setting('hnsw.ef_search') AS ef, current_setting('hnsw.iterative_scan') AS scan",
    );
    expect(settings.rows[0]).toEqual({ ef: "40", scan: "off" });
    expect(
      await rankEmbeddings(client(), {
        collectionIds: ["collection_a"],
        source: "notion",
        modelId: "m",
        queryEmbedding: sparse({ 0: 1 }),
        limit: 10,
      }),
    ).toEqual([]);
  });
});

describe("a database on the one-table shape", () => {
  it("moves every row into the collections' partitions, and re-applying changes nothing", async () => {
    await addCollections("collection_a", "collection_b");
    const freshIndexes = await indexNames();
    await db.exec(`
      DROP TABLE embeddings;
      CREATE TABLE embeddings (
        collection_id       text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        source        text NOT NULL CHECK (source IN ('node','notion','slack')),
        entity_id     text NOT NULL,
        chunk_index   int  NOT NULL DEFAULT 0,
        model_id      text NOT NULL,
        content_hash  text NOT NULL,
        chunk_text    text NOT NULL,
        embedding     vector(1536) NOT NULL,
        updated_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (collection_id, entity_id, chunk_index)
      );
      CREATE INDEX embeddings_source_idx ON embeddings (collection_id, source, model_id);
      CREATE INDEX embeddings_hnsw_idx ON embeddings USING hnsw (embedding vector_cosine_ops);
    `);
    await db.query(
      `INSERT INTO embeddings
         (collection_id, source, entity_id, chunk_index, model_id, content_hash, chunk_text, embedding, updated_at)
       VALUES ('collection_a', 'node', 'decision_1', 0, 'm', 'h1', 'apple', $1::vector, '2026-01-01'),
              ('collection_a', 'node', 'decision_1', 1, 'm', 'h2', 'pie', $2::vector, '2026-01-02'),
              ('collection_b', 'slack', 'C1:1', 0, 'm', 'h3', 'hi', $2::vector, '2026-01-03')`,
      [vectorLiteral(sparse({ 0: 1 })), vectorLiteral(sparse({ 1: 0.25, 700: 0.5 }))],
    );

    await db.exec(schemaSql);

    expect(await partitions()).toEqual(["embeddings_collection_a", "embeddings_collection_b"]);
    const rows = async () =>
      (
        await db.query(
          `SELECT collection_id, source, entity_id, chunk_index, model_id, content_hash, chunk_text,
                  embedding::text AS embedding, updated_at::text AS updated_at
             FROM embeddings ORDER BY collection_id, entity_id, chunk_index`,
        )
      ).rows;
    const moved = await rows();
    expect(moved.map((r) => Object.values(r).slice(0, 7))).toEqual([
      ["collection_a", "node", "decision_1", 0, "m", "h1", "apple"],
      ["collection_a", "node", "decision_1", 1, "m", "h2", "pie"],
      ["collection_b", "slack", "C1:1", 0, "m", "h3", "hi"],
    ]);
    expect((moved[1] as { embedding: string }).embedding).toBe(
      vectorLiteral(sparse({ 1: 0.25, 700: 0.5 })),
    );
    expect((moved[2] as { updated_at: string }).updated_at).toMatch(/^2026-01-03/);
    expect(await indexNames()).toEqual(freshIndexes);
    const tables = await db.query(
      "SELECT relname FROM pg_class WHERE relname LIKE 'embeddings%' AND relkind IN ('r', 'p') AND relispartition = false",
    );
    expect(tables.rows).toEqual([{ relname: "embeddings" }]);

    await db.exec(schemaSql);
    expect(await rows()).toEqual(moved);
  });
});

async function indexNames(): Promise<string[]> {
  return (
    await db.query<{ n: string }>(
      "SELECT indexname AS n FROM pg_indexes WHERE tablename LIKE 'embeddings%' ORDER BY 1",
    )
  ).rows.map((r) => r.n);
}
