// account_grants is retired: the live "all my workspaces (incl. future)"
// person-to-person delegation is gone — that breadth now lives only on tokens
// (the actor/mint-snapshot paths). A pre-existing prod table still holds live
// grants, so re-applying schema.sql must convert each one into the concrete
// memberships it currently confers (a snapshot of the grantor's owned
// workspaces + personally-owned docos) so no one loses access, then drop the
// table. This test reproduces that legacy shape and asserts the heal.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

let db: PGlite;

/** Stand up the legacy account_grants table (dropped from the current baseline). */
async function legacyAccountGrants(): Promise<void> {
  await db.exec(`
    DROP TABLE IF EXISTS account_grants CASCADE;
    CREATE TABLE account_grants (
      grantor_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      grantee_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role            text NOT NULL CHECK (role IN ('owner','writer','reader')),
      write_types     text[] NOT NULL DEFAULT ARRAY[]::text[],
      created_at      timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (grantor_user_id, grantee_user_id)
    );
  `);
}

async function tableExists(table: string): Promise<boolean> {
  const r = await db.query("SELECT to_regclass($1) AS reg", [`public.${table}`]);
  return (r.rows[0] as { reg: string | null }).reg !== null;
}

describe("account_grants retirement migration", () => {
  beforeEach(async () => {
    db = await freshDb();
    // Grantor A owns workspace W and a personal doco D; B is the grantee.
    await db.exec(`
      INSERT INTO users (id, data) VALUES ('user_a', '{}'), ('user_b', '{}');
      INSERT INTO workspaces (id, handle, name) VALUES ('workspace_w', 'w', 'W');
      INSERT INTO workspace_users (workspace_id, user_id, role)
        VALUES ('workspace_w', 'user_a', 'owner');
      INSERT INTO docos (id, handle, owner_id, workspace_id, data)
        VALUES ('doco_d', 'd', 'user_a', 'workspace_w', '{}'::jsonb);
    `);
  });

  it("converts each account grant into concrete memberships, then drops the table", async () => {
    await legacyAccountGrants();
    await db.exec(
      `INSERT INTO account_grants (grantor_user_id, grantee_user_id, role, write_types)
       VALUES ('user_a', 'user_b', 'writer', ARRAY['decision'])`,
    );

    // The next change to schema.sql re-applies the whole file.
    await db.exec(schemaSql);

    expect(await tableExists("account_grants")).toBe(false);

    const wu = await db.query(
      `SELECT role, write_types FROM workspace_users WHERE workspace_id = 'workspace_w' AND user_id = 'user_b'`,
    );
    expect(wu.rows[0]).toMatchObject({ role: "writer", write_types: ["decision"] });

    const du = await db.query(
      `SELECT role, write_types FROM doco_users WHERE doco_id = 'doco_d' AND user_id = 'user_b'`,
    );
    expect(du.rows[0]).toMatchObject({ role: "writer", write_types: ["decision"] });
  });

  it("never downgrades an existing concrete membership (ON CONFLICT DO NOTHING)", async () => {
    // B is already an OWNER of W directly; the account grant is only 'reader'.
    await db.exec(
      `INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ('workspace_w', 'user_b', 'owner')`,
    );
    await legacyAccountGrants();
    await db.exec(
      `INSERT INTO account_grants (grantor_user_id, grantee_user_id, role) VALUES ('user_a', 'user_b', 'reader')`,
    );

    await db.exec(schemaSql);

    const wu = await db.query(
      `SELECT role FROM workspace_users WHERE workspace_id = 'workspace_w' AND user_id = 'user_b'`,
    );
    expect(wu.rows[0]).toMatchObject({ role: "owner" });
  });

  it("is a no-op on a fresh database that never had the table", async () => {
    // freshDb already applied schema.sql once with no account_grants present.
    await db.exec(schemaSql); // re-apply — must not error
    expect(await tableExists("account_grants")).toBe(false);
  });
});
