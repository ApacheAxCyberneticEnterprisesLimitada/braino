import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { embeddingLiteral, upsertEmbeddings } from "../embeddings.js";
import { freshDb } from "./fresh-db.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

describe("embedding storage without pgvector", () => {
  it("stores ordinary Postgres real arrays and installs no vector extension or HNSW index", async () => {
    const extension = await db.query<{ installed: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS installed",
    );
    const column = await db.query<{ data_type: string; udt_name: string }>(
      `SELECT data_type, udt_name
         FROM information_schema.columns
        WHERE table_name = 'embeddings' AND column_name = 'embedding'`,
    );
    const hnsw = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM pg_indexes
        WHERE indexdef ILIKE '%USING hnsw%'`,
    );

    expect(extension.rows[0]?.installed).toBe(false);
    expect(column.rows).toEqual([{ data_type: "ARRAY", udt_name: "_float4" }]);
    expect(hnsw.rows[0]?.count).toBe(0);
  });

  it("writes embedding values without a vector cast", async () => {
    await db.exec(`
      INSERT INTO workspaces (id, handle, name) VALUES ('ws', 'ws', 'WS');
      INSERT INTO collections (id, handle, owner_id, workspace_id, data)
        VALUES ('collection_1', 'd', 'ws', 'ws', '{}'::jsonb);
    `);
    const provider = {
      modelId: "test:model",
      dimensions: 3,
      async embed() {
        return [Float32Array.from([1, 0.5, -0.25])];
      },
    };

    await upsertEmbeddings(
      db,
      [{ collection_id: "collection_1", source: "node", entity_id: "decision_1", chunks: ["One"] }],
      provider,
    );

    const values = await db.query<{ embedding: number[] }>(
      "SELECT embedding FROM embeddings WHERE entity_id = 'decision_1'",
    );
    expect(values.rows[0]?.embedding.slice(0, 3)).toEqual([1, 0.5, -0.25]);
    expect(values.rows[0]?.embedding).toHaveLength(1536);
    expect(embeddingLiteral([1, 0.5, -0.25], 3)).toBe("{1,0.5,-0.25}");
  });
});
