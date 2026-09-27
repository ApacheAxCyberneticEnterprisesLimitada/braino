// The consent screens can mint an "all workspaces" credential: grant_type='actor'.
// That value rides the OAuth code and device-authorization rows on its way to
// the refresh token, so both tables carry a grant_type column with a CHECK that
// admits only 'regular' (default) and 'actor'. schema.sql is re-applied on every
// boot, so this is a real-Postgres proof the columns + constraint exist.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";

let db: PGlite;

describe("oauth grant_type column (regular | actor)", () => {
  beforeEach(async () => {
    db = await freshDb();
    await db.query("INSERT INTO users (id, data) VALUES ('user_alice', '{}')");
    await db.query(
      "INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ('doco_client_x', 'x', ARRAY['urn:ietf:wg:oauth:2.0:oob'])",
    );
  });

  it("defaults authorization codes to 'regular' and accepts 'actor'", async () => {
    await db.query(
      `INSERT INTO oauth_authorization_codes
         (code, client_id, user_id, redirect_uri, code_challenge, granted_doco_ids, expires_at)
       VALUES ('c_reg', 'doco_client_x', 'user_alice', 'urn:x', 'ch', ARRAY['doco_1'], now() + interval '5 min')`,
    );
    await db.query(
      `INSERT INTO oauth_authorization_codes
         (code, client_id, user_id, redirect_uri, code_challenge, granted_doco_ids, grant_type, expires_at)
       VALUES ('c_act', 'doco_client_x', 'user_alice', 'urn:x', 'ch', ARRAY[]::text[], 'actor', now() + interval '5 min')`,
    );

    const rows = await db.query<{ code: string; grant_type: string }>(
      "SELECT code, grant_type FROM oauth_authorization_codes ORDER BY code",
    );
    expect(rows.rows).toEqual([
      { code: "c_act", grant_type: "actor" },
      { code: "c_reg", grant_type: "regular" },
    ]);
  });

  it("defaults device authorizations to 'regular' and accepts 'actor'", async () => {
    await db.query(
      `INSERT INTO oauth_device_authorizations
         (device_code, user_code, client_id, expires_at)
       VALUES ('dc_reg', 'AAAA-1111', 'doco_client_x', now() + interval '5 min')`,
    );
    await db.query(
      `INSERT INTO oauth_device_authorizations
         (device_code, user_code, client_id, grant_type, expires_at)
       VALUES ('dc_act', 'BBBB-2222', 'doco_client_x', 'actor', now() + interval '5 min')`,
    );

    const rows = await db.query<{ device_code: string; grant_type: string }>(
      "SELECT device_code, grant_type FROM oauth_device_authorizations ORDER BY device_code",
    );
    expect(rows.rows).toEqual([
      { device_code: "dc_act", grant_type: "actor" },
      { device_code: "dc_reg", grant_type: "regular" },
    ]);
  });

  it("rejects a grant_type outside the allowed set", async () => {
    await expect(
      db.query(
        `INSERT INTO oauth_authorization_codes
           (code, client_id, user_id, redirect_uri, code_challenge, granted_doco_ids, grant_type, expires_at)
         VALUES ('c_bad', 'doco_client_x', 'user_alice', 'urn:x', 'ch', ARRAY['doco_1'], 'superuser', now() + interval '5 min')`,
      ),
    ).rejects.toThrow();
  });

  it("stores the actor_role ceiling (reader|writer|owner|null) on refresh tokens", async () => {
    await db.query(
      `INSERT INTO oauth_refresh_tokens
         (token, client_id, user_id, granted_doco_ids, grant_type, actor_role, expires_at)
       VALUES ('rt_cap', 'doco_client_x', 'user_alice', ARRAY[]::text[], 'actor', 'reader', now() + interval '60 days')`,
    );
    // Default is NULL (no ceiling = full live role).
    await db.query(
      `INSERT INTO oauth_refresh_tokens
         (token, client_id, user_id, granted_doco_ids, grant_type, expires_at)
       VALUES ('rt_full', 'doco_client_x', 'user_alice', ARRAY[]::text[], 'actor', now() + interval '60 days')`,
    );

    const rows = await db.query<{ token: string; actor_role: string | null }>(
      "SELECT token, actor_role FROM oauth_refresh_tokens ORDER BY token",
    );
    expect(rows.rows).toEqual([
      { token: "rt_cap", actor_role: "reader" },
      { token: "rt_full", actor_role: null },
    ]);
  });

  it("rejects an actor_role outside reader|writer|owner", async () => {
    await expect(
      db.query(
        `INSERT INTO oauth_refresh_tokens
           (token, client_id, user_id, granted_doco_ids, grant_type, actor_role, expires_at)
         VALUES ('rt_bad', 'doco_client_x', 'user_alice', ARRAY[]::text[], 'actor', 'superuser', now() + interval '60 days')`,
      ),
    ).rejects.toThrow();
  });
});
