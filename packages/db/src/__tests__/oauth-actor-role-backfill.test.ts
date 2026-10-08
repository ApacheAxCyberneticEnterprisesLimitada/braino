// A column added inline to a `CREATE TABLE IF NOT EXISTS` is NOT applied to a
// table that already exists — the CREATE is a no-op on re-boot. `actor_role`
// shipped that way, so production's pre-existing oauth tables never got it, and
// every authorize/refresh/device path that names the column 500'd (most
// visibly, the /tokens page). The fix is an idempotent ADD COLUMN IF NOT EXISTS
// in schema.sql's migration tail; this test is the regression guard: a table
// missing the column must be HEALED by re-applying schema.sql.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

const OAUTH_TABLES = [
  "oauth_authorization_codes",
  "oauth_refresh_tokens",
  "oauth_device_authorizations",
];

let db: PGlite;

async function hasColumn(table: string, column: string): Promise<boolean> {
  const r = await db.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2",
    [table, column],
  );
  return r.rows.length === 1;
}

describe("oauth actor_role column backfill", () => {
  beforeEach(async () => {
    db = await freshDb();
    await db.query("INSERT INTO users (id, data) VALUES ('user_a', '{}')");
    await db.query(
      "INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ('doco_client_x', 'x', ARRAY['urn:ietf:wg:oauth:2.0:oob'])",
    );
  });

  it("re-applying schema.sql heals oauth tables that predate the actor_role column", async () => {
    // Simulate the production shape: tables created before actor_role existed.
    for (const table of OAUTH_TABLES) {
      await db.exec(`ALTER TABLE ${table} DROP COLUMN actor_role;`);
      expect(await hasColumn(table, "actor_role")).toBe(false);
    }

    // The next change to schema.sql re-applies the whole file.
    await db.exec(schemaSql);

    for (const table of OAUTH_TABLES) {
      expect(await hasColumn(table, "actor_role")).toBe(true);
    }
  });

  it("still accepts a valid ceiling and rejects a bogus one after the backfill", async () => {
    await db.exec("ALTER TABLE oauth_refresh_tokens DROP COLUMN actor_role;");
    await db.exec(schemaSql); // heal

    await db.exec(
      `INSERT INTO oauth_refresh_tokens
         (token, client_id, user_id, granted_doco_ids, grant_type, actor_role, expires_at)
       VALUES ('rt_ok', 'doco_client_x', 'user_a', ARRAY[]::text[], 'actor', 'reader', now() + interval '60 days')`,
    );
    await expect(
      db.exec(
        `INSERT INTO oauth_refresh_tokens
           (token, client_id, user_id, granted_doco_ids, grant_type, actor_role, expires_at)
         VALUES ('rt_bad', 'doco_client_x', 'user_a', ARRAY[]::text[], 'actor', 'superuser', now() + interval '60 days')`,
      ),
    ).rejects.toThrow();
  });
});
