import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";

describe("MCP OAuth resource migration", () => {
  it("invalidates old codes and adds a resource audience without inventing one for old tokens", async () => {
    const db = await freshDb();
    await db.exec(`
      ALTER TABLE oauth_authorization_codes DROP COLUMN resource;
      ALTER TABLE oauth_access_tokens DROP COLUMN resource;
      ALTER TABLE oauth_refresh_tokens DROP COLUMN resource;
      INSERT INTO users (id, data) VALUES ('user_legacy', '{}'::jsonb);
      INSERT INTO oauth_clients
        (client_id, redirect_uris, grant_types, response_types)
      VALUES
        ('doco_client_legacy', ARRAY['urn:test'], ARRAY['authorization_code'], ARRAY['code']);
    `);
    await db.query(
      `INSERT INTO oauth_authorization_codes
         (code, client_id, user_id, redirect_uri, code_challenge, granted_collection_ids, expires_at)
       VALUES ('legacy_code', 'doco_client_legacy', 'user_legacy', 'urn:test', 'challenge',
               ARRAY[]::text[], now() + interval '1 minute')`,
    );
    const migration = await readFile(
      join(import.meta.dirname, "..", "..", "migrations", "008_mcp_oauth_resource.sql"),
      "utf8",
    );

    await db.exec(migration);

    const columns = await db.query<{ table_name: string; is_nullable: string }>(`
      SELECT table_name, is_nullable
        FROM information_schema.columns
       WHERE column_name = 'resource'
         AND table_name IN (
           'oauth_authorization_codes', 'oauth_access_tokens', 'oauth_refresh_tokens'
         )
       ORDER BY table_name
    `);
    expect(columns.rows).toEqual([
      { table_name: "oauth_access_tokens", is_nullable: "YES" },
      { table_name: "oauth_authorization_codes", is_nullable: "NO" },
      { table_name: "oauth_refresh_tokens", is_nullable: "YES" },
    ]);
    const legacyCodes = await db.query("SELECT code FROM oauth_authorization_codes");
    expect(legacyCodes.rows).toEqual([]);
  });
});
