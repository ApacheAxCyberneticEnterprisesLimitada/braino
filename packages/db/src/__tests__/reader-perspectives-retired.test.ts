// Alexander, 2026-10-01: codebase and Notion Docos open in a reader of their
// own, so the Code and Notion perspectives are gone. schema.sql, which
// re-applies on every boot, deletes their built-in rows and every Doco's
// attachment to them, and the kinds leave the perspectives CHECK. Slack keeps
// its perspective.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

let db: PGlite;

async function perspectiveIds(): Promise<string[]> {
  const r = await db.query<{ id: string }>("SELECT id FROM perspectives ORDER BY id");
  return r.rows.map((row) => row.id);
}

describe("the Code and Notion perspectives are retired", () => {
  beforeEach(async () => {
    db = await freshDb();
  });

  it("are not built in on a fresh database, while Slack's still is", async () => {
    const ids = await perspectiveIds();
    expect(ids).not.toContain("perspective_code");
    expect(ids).not.toContain("perspective_notion");
    expect(ids).toContain("perspective_slack");
  });

  it("leave a database that had them, with every Doco's attachment to them", async () => {
    await db.exec(`
      ALTER TABLE perspectives DROP CONSTRAINT perspectives_kind_check;
      INSERT INTO perspectives (id, slug, kind, name, is_builtin) VALUES
        ('perspective_code', 'code', 'code', 'Code', true),
        ('perspective_notion', 'notion', 'notion', 'Notion', true);
      INSERT INTO workspaces (id, handle, name) VALUES ('workspace_acme', 'acme', 'Acme');
      INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES
        ('doco_code', 'acme-codebase', 'workspace_acme', 'workspace_acme', '{}'::jsonb);
      INSERT INTO doco_perspectives (doco_id, perspective_id, position, is_default) VALUES
        ('doco_code', 'perspective_graph', 0, false),
        ('doco_code', 'perspective_code', 2, true);
    `);

    await db.exec(schemaSql);

    expect(await perspectiveIds()).not.toContain("perspective_code");
    const attached = await db.query<{ perspective_id: string }>(
      "SELECT perspective_id FROM doco_perspectives WHERE doco_id = 'doco_code'",
    );
    expect(attached.rows).toEqual([{ perspective_id: "perspective_graph" }]);
    await expect(
      db.exec(
        "INSERT INTO perspectives (id, slug, kind, name) VALUES ('p_code', 'code2', 'code', 'Code')",
      ),
    ).rejects.toThrow(/perspectives_kind_check/);
  });
});
