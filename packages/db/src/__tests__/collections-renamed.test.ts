// What a workspace holds is called a collection now, not a Doco
// (decision_01M5AC1FY3CF7ZXC0M59EZR4Z3). Production still has the docos
// tables, so re-applying schema.sql renames them, and every column,
// constraint, index and trigger named for them, in place: the database ends up
// exactly as a fresh one, keeping every row and each id as it was minted. A
// Slack channel connected to one collection and the grants of pending invites
// name the level, so they follow it.
//
// The legacy database is this schema.sql with the rename block left out and
// "collection" spelled "doco" everywhere, which is the schema before the rename.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

const BLOCK_START = "-- Docos became collections";
const BLOCK_END = "END $$;\n";
const ID = "doco_01KT1ZBP73GYF1VX7S7XF1RKHJ";

function legacySchema(): string {
  const start = schemaSql.indexOf(BLOCK_START);
  const end = schemaSql.indexOf(BLOCK_END, start) + BLOCK_END.length;
  return (schemaSql.slice(0, start) + schemaSql.slice(end))
    .replaceAll("COLLECTION", "DOCO")
    .replaceAll("Collection", "Doco")
    .replaceAll("collection", "doco");
}

/** Every table and view column, constraint, index, trigger and function, leaving out
 *  the embeddings partitions, whose names come from the ids they hold. */
async function shape(db: PGlite): Promise<string[]> {
  const r = await db.query<{ line: string }>(`
    WITH rels AS (
      SELECT oid, relname FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND NOT relispartition
    )
    SELECT 'column ' || r.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) AS line
      FROM pg_attribute a JOIN rels r ON r.oid = a.attrelid
      JOIN pg_class c ON c.oid = r.oid AND c.relkind IN ('r', 'p', 'v')
     WHERE a.attnum > 0 AND NOT a.attisdropped
    UNION ALL
    SELECT 'constraint ' || r.relname || '.' || co.conname || ' ' || pg_get_constraintdef(co.oid)
      FROM pg_constraint co JOIN rels r ON r.oid = co.conrelid
    UNION ALL
    SELECT 'index ' || i.relname || ' ' || pg_get_indexdef(i.oid)
      FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN rels r ON r.oid = x.indrelid
    UNION ALL
    SELECT 'trigger ' || r.relname || '.' || t.tgname || ' ' || pg_get_triggerdef(t.oid)
      FROM pg_trigger t JOIN rels r ON r.oid = t.tgrelid
     WHERE NOT t.tgisinternal
    UNION ALL
    SELECT 'function ' || p.oid::regprocedure::text || ' ' || pg_get_function_result(p.oid)
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
     ORDER BY 1`);
  return r.rows.map((row) => row.line);
}

let db: PGlite;

describe("docos become collections", () => {
  beforeEach(async () => {
    db = await freshDb();
    await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await db.exec(legacySchema());
    await db.exec(`
      INSERT INTO users (id, data) VALUES ('user_a', '{}');
      INSERT INTO workspaces (id, handle, name) VALUES ('workspace_w', 'w', 'W');
      INSERT INTO docos (id, handle, owner_id, workspace_id, data)
        VALUES ('${ID}', 'product', 'workspace_w', 'workspace_w', '{}');
      INSERT INTO doco_users (doco_id, user_id, role) VALUES ('${ID}', 'user_a', 'writer');
      INSERT INTO group_chat_channel_connections
          (id, provider, workspace_id, channel_id, target_level, target_id, role)
        VALUES ('gcc_one', 'slack', 'T1', 'C1', 'doco', '${ID}', 'reader'),
               ('gcc_all', 'slack', 'T1', 'C2', 'workspace', 'workspace_w', 'author');
      INSERT INTO tokens_blob (key, blob) VALUES ('invites', '{
        "schema_version": 2,
        "tokens": [
          {"kind": "invite", "code": "c1", "doco_id": "${ID}", "status": "pending",
           "grants": [{"level": "doco", "target_id": "${ID}", "role": "reader", "write_types": []},
                      {"level": "workspace", "target_id": "workspace_w", "role": "writer", "write_types": ["*"]}]},
          {"kind": "invite", "code": "c2", "status": "pending", "grants": []}
        ]}');
    `);
  });

  it("ends up exactly as a fresh database", async () => {
    await db.exec(schemaSql);

    expect(await shape(db)).toEqual(await shape(await freshDb()));
  });

  it("keeps every row, each id as it was minted, and its embeddings partition", async () => {
    await db.exec(schemaSql);

    const collections = await db.query("SELECT id, handle, workspace_id FROM collections");
    expect(collections.rows).toEqual([{ id: ID, handle: "product", workspace_id: "workspace_w" }]);
    const users = await db.query("SELECT collection_id, user_id, role FROM collection_users");
    expect(users.rows).toEqual([{ collection_id: ID, user_id: "user_a", role: "writer" }]);
    const partition = await db.query(
      "SELECT pg_get_expr(c.relpartbound, c.oid) AS bound FROM pg_class c WHERE c.relname = $1",
      [`embeddings_${ID}`],
    );
    expect(partition.rows).toEqual([{ bound: `FOR VALUES IN ('${ID}')` }]);
  });

  it("points a channel connected to one collection at the collection level", async () => {
    await db.exec(schemaSql);

    const rows = await db.query(
      "SELECT id, target_level FROM group_chat_channel_connections ORDER BY id",
    );
    expect(rows.rows).toEqual([
      { id: "gcc_all", target_level: "workspace" },
      { id: "gcc_one", target_level: "collection" },
    ]);
  });

  it("names the collection in pending invites and their grants", async () => {
    await db.exec(schemaSql);

    const r = await db.query<{ blob: { tokens: unknown[] } }>(
      "SELECT blob FROM tokens_blob WHERE key = 'invites'",
    );
    expect(r.rows[0]?.blob.tokens).toEqual([
      {
        kind: "invite",
        code: "c1",
        collection_id: ID,
        status: "pending",
        grants: [
          { level: "collection", target_id: ID, role: "reader", write_types: [] },
          { level: "workspace", target_id: "workspace_w", role: "writer", write_types: ["*"] },
        ],
      },
      { kind: "invite", code: "c2", status: "pending", grants: [] },
    ]);
  });

  it("runs the renamed triggers once each: a new collection gets its partition", async () => {
    await db.exec(schemaSql);

    await db.exec(`
      INSERT INTO collections (id, handle, owner_id, workspace_id, data)
        VALUES ('collection_01KT1ZBP73GYF1VX7S7XF1RKHK', 'later', 'workspace_w', 'workspace_w', '{}');
    `);
    const partitions = await db.query(
      `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'embeddings'::regclass ORDER BY 1`,
    );
    expect(partitions.rows).toEqual([
      { relname: "embeddings_collection_01KT1ZBP73GYF1VX7S7XF1RKHK" },
      { relname: `embeddings_${ID}` },
    ]);
  });

  it("leaves a renamed database alone when the schema is applied again", async () => {
    await db.exec(schemaSql);
    const once = await shape(db);

    await db.exec(schemaSql);

    expect(await shape(db)).toEqual(once);
    const r = await db.query("SELECT target_level FROM group_chat_channel_connections ORDER BY id");
    expect(r.rows).toEqual([{ target_level: "workspace" }, { target_level: "collection" }]);
  });
});
