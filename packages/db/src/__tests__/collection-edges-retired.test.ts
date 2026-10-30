import { describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

describe("collection_edges retirement", () => {
  it("drops the table from a database that shipped collection linking", async () => {
    const db = await freshDb();
    await db.exec(`
      CREATE UNIQUE INDEX collections_id_workspace_uniq
        ON collections (id, workspace_id);
      CREATE TABLE collection_edges (
        id text PRIMARY KEY,
        edge_type text NOT NULL
      );
      INSERT INTO collection_edges (id, edge_type)
      VALUES ('collection_edge_1', 'implements');
    `);

    await db.exec(schemaSql);

    const result = await db.query<{ table_name: string | null }>(
      "SELECT to_regclass('public.collection_edges')::text AS table_name",
    );
    expect(result.rows[0]?.table_name).toBeNull();

    const index = await db.query<{ index_name: string | null }>(
      "SELECT to_regclass('public.collections_id_workspace_uniq')::text AS index_name",
    );
    expect(index.rows[0]?.index_name).toBeNull();
  });
});
