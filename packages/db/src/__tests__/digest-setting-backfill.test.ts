// How often a member gets a workspace's activity digest is one column,
// workspace_users.digest: 'daily' (the default), 'weekly' or 'off'. It
// replaced digest_unsubscribed_at, from when the digest was daily only during
// a workspace's first week: on the boot that adds it, whoever had unsubscribed
// stays off and everyone else gets it daily.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

let db: PGlite;

async function digests(): Promise<Record<string, string>> {
  const r = await db.query<{ user_id: string; digest: string }>(
    "SELECT user_id, digest FROM workspace_users ORDER BY user_id",
  );
  return Object.fromEntries(r.rows.map((row) => [row.user_id, row.digest]));
}

describe("the digest setting replaces the unsubscribe timestamp", () => {
  beforeEach(async () => {
    db = await freshDb();
    // A database from before the column.
    await db.exec(`
      ALTER TABLE workspace_users DROP COLUMN digest;
      ALTER TABLE workspace_users ADD COLUMN digest_unsubscribed_at timestamptz;
      INSERT INTO users (id, github_login, data) VALUES
        ('user_ana', 'ana', '{}'), ('user_bo', 'bo', '{}');
      INSERT INTO workspaces (id, handle, name) VALUES ('workspace_acme', 'acme', 'acme');
      INSERT INTO workspace_users (workspace_id, user_id, role, digest_unsubscribed_at) VALUES
        ('workspace_acme', 'user_ana', 'owner', NULL),
        ('workspace_acme', 'user_bo', 'writer', now());
    `);
  });

  it("keeps who unsubscribed off and sends everyone else the daily digest", async () => {
    await db.exec(schemaSql);
    expect(await digests()).toEqual({ user_ana: "daily", user_bo: "off" });
    const { rows } = await db.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'workspace_users' AND column_name = 'digest_unsubscribed_at'`,
    );
    expect(rows).toEqual([]);
  });

  it("leaves the settings people chose on every later boot", async () => {
    await db.exec(schemaSql);
    await db.exec("UPDATE workspace_users SET digest = 'weekly' WHERE user_id = 'user_ana'");
    await db.exec(schemaSql);
    expect(await digests()).toEqual({ user_ana: "weekly", user_bo: "off" });
  });

  it("takes only daily, weekly or off", async () => {
    await db.exec(schemaSql);
    await expect(
      db.exec("UPDATE workspace_users SET digest = 'monthly' WHERE user_id = 'user_ana'"),
    ).rejects.toThrow();
  });
});
