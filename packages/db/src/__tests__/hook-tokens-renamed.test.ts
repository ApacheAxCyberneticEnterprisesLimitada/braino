// Project tokens are hook tokens now: the table, its index and every token's
// prefix follow the name. Production still has project_tokens with doco_pt_
// tokens, so re-applying schema.sql renames the table and each token in place,
// keeping who made it, its label and when it was last used. A hook holding an
// old token gets a 401 and asks its agent to fetch the renamed one with
// doco_hook_token.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

let db: PGlite;

async function tableExists(table: string): Promise<boolean> {
  const r = await db.query("SELECT to_regclass($1) AS reg", [`public.${table}`]);
  return (r.rows[0] as { reg: string | null }).reg !== null;
}

/** Stand up the legacy project_tokens table in place of hook_tokens. */
async function legacyProjectTokens(): Promise<void> {
  await db.exec(`
    DROP TABLE hook_tokens;
    CREATE TABLE project_tokens (
      token                 text PRIMARY KEY,
      workspace_id          text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      created_by_user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label                 text,
      revoked               boolean NOT NULL DEFAULT false,
      created_at            timestamptz NOT NULL DEFAULT now(),
      last_used_at          timestamptz
    );
    CREATE INDEX project_tokens_workspace_idx
      ON project_tokens (workspace_id) WHERE NOT revoked;
  `);
}

describe("project_tokens becomes hook_tokens", () => {
  beforeEach(async () => {
    db = await freshDb();
    await db.exec(`
      INSERT INTO users (id, data) VALUES ('user_a', '{}');
      INSERT INTO workspaces (id, handle, name) VALUES ('workspace_w', 'w', 'W');
    `);
  });

  it("renames the table, its index and every token's prefix, keeping the rest", async () => {
    await legacyProjectTokens();
    await db.exec(`
      INSERT INTO project_tokens (token, workspace_id, created_by_user_id, label, last_used_at)
      VALUES ('doco_pt_abcdefgh12345678', 'workspace_w', 'user_a', 'Doco hook',
              '2026-10-07T12:00:00Z');
    `);

    await db.exec(schemaSql);

    expect(await tableExists("project_tokens")).toBe(false);
    expect(await tableExists("project_tokens_workspace_idx")).toBe(false);
    expect(await tableExists("hook_tokens_workspace_idx")).toBe(true);
    const rows = await db.query(
      "SELECT token, created_by_user_id, label, revoked, last_used_at FROM hook_tokens",
    );
    expect(rows.rows).toEqual([
      {
        token: "doco_ht_abcdefgh12345678",
        created_by_user_id: "user_a",
        label: "Doco hook",
        revoked: false,
        last_used_at: new Date("2026-10-07T12:00:00Z"),
      },
    ]);
  });

  it("leaves hook_tokens alone when the schema is applied again", async () => {
    await db.exec(`
      INSERT INTO hook_tokens (token, workspace_id, created_by_user_id)
      VALUES ('doco_ht_zyxwvuts87654321', 'workspace_w', 'user_a');
    `);

    await db.exec(schemaSql);

    expect(await tableExists("project_tokens")).toBe(false);
    const rows = await db.query("SELECT token FROM hook_tokens");
    expect(rows.rows).toEqual([{ token: "doco_ht_zyxwvuts87654321" }]);
  });
});
