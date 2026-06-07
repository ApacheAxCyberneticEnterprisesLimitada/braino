// Entity-shape normalization, slice D — the node bag is named `extra`, not
// `attributes`. `extra` is the one sanctioned per-node bag: author-owned, empty
// by default, the system stores nothing in it. This pins the idempotent
// schema.sql migration that renames the column in place on an already-seeded
// database (a fresh DB gets `extra` straight from CREATE TABLE), preserving the
// bag contents — the upgrade path the PGlite-fresh tests miss.
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { freshDb, schemaSql } from "./fresh-db.js";

const DOCO = "doco_extra00000000000000000000000";
const ORG = "workspace_extra000000000000000";

async function columnNames(db: PGlite): Promise<string[]> {
  const r = await db.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'nodes'",
  );
  return r.rows.map((row) => row.column_name);
}

describe("rename the node bag attributes -> extra (slice D)", () => {
  it("a fresh schema has the `extra` column and no `attributes` column", async () => {
    const db = await freshDb();
    const cols = await columnNames(db);
    expect(cols).toContain("extra");
    expect(cols).not.toContain("attributes");
  });

  it("renames an old `attributes` column to `extra` in place, contents intact", async () => {
    const db = new PGlite();
    // Pre-slice-D shape: the bag column is still named `attributes`.
    await db.exec(`
      CREATE TABLE nodes (
        id text PRIMARY KEY,
        doco_id text NOT NULL,
        node_type text NOT NULL,
        lifecycle text NOT NULL DEFAULT 'active',
        prose text NOT NULL DEFAULT '',
        kind text,
        locator text,
        attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        created_by text,
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by text
      );
      CREATE INDEX nodes_ref_locator_idx ON nodes (doco_id, locator) WHERE node_type = 'reference';
      INSERT INTO nodes (id, doco_id, node_type, prose, locator, attributes)
      VALUES ('reference_extra0000000000000000', '${DOCO}', 'reference', 'A ref',
              'https://github.com/a/b/pull/1', jsonb_build_object('content_hash', 'h1', 'note', 'kept'));
    `);

    await db.exec(schemaSql);

    const cols = await columnNames(db);
    expect(cols).toContain("extra");
    expect(cols).not.toContain("attributes");

    const r = await db.query<{
      extra: Record<string, unknown>;
      prose: string;
      locator: string | null;
    }>("SELECT extra, prose, locator FROM nodes WHERE id = 'reference_extra0000000000000000'");
    // Bag contents survived the rename in place.
    expect(r.rows[0].extra).toEqual({ content_hash: "h1", note: "kept" });
    expect(r.rows[0].prose).toBe("A ref");
    expect(r.rows[0].locator).toBe("https://github.com/a/b/pull/1");

    // Idempotent: a second apply is a no-op (column already renamed).
    await db.exec(schemaSql);
    const again = await db.query<{ extra: Record<string, unknown> }>(
      "SELECT extra FROM nodes WHERE id = 'reference_extra0000000000000000'",
    );
    expect(again.rows[0].extra).toEqual({ content_hash: "h1", note: "kept" });
  });

  it("round-trips a write through the renamed column via the repo", async () => {
    const db = await freshDb();
    await db.query("INSERT INTO workspaces (id, handle, name) VALUES ($1,$2,$3)", [
      ORG,
      "ws-extra",
      "WS Extra",
    ]);
    await db.query(
      "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ($1,$2,$3,$4,'{}'::jsonb)",
      [DOCO, "doco-extra", ORG, ORG],
    );
    const { upsertEntity, rowToNode } = await import("../repo.js");
    const id = "action_extra00000000000000000000";
    await upsertEntity(
      {
        id,
        doco_id: DOCO,
        entity_type: "action",
        data: {
          id,
          doco_id: DOCO,
          node_type: "action",
          action: "Did it",
          verb: "do",
          lifecycle: "active",
        },
        lifecycle: "active",
      } as never,
      db as never,
    );
    const { rows } = await db.query<Record<string, unknown>>("SELECT * FROM nodes WHERE id = $1", [
      id,
    ]);
    const rec = rowToNode(rows[0]);
    // The free-form field lands in the `extra` bag and is surfaced on read.
    expect((rows[0] as { extra: Record<string, unknown> }).extra).toMatchObject({ verb: "do" });
    expect(rec.extra).toMatchObject({ verb: "do" });
  });
});
