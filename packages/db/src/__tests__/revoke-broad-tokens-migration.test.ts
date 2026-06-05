// The single-workspace token rule: a token may reach at most one workspace,
// and the legacy defer-scope '*' ("Full access") token is gone. schema.sql is
// re-applied on every boot, so the deploy cutover that revokes any pre-existing
// broad token is a self-healing block in the baseline. This test seeds broad
// and narrow tokens, re-applies the baseline (what every boot does), and
// asserts exactly the broad ones get revoked.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

const WS_A = "workspace_01AAAAAAAAAAAAAAAAAAAAAAAA";
const WS_B = "workspace_01BBBBBBBBBBBBBBBBBBBBBBBB";

let db: PGlite;

async function insertToken(
  table: "oauth_access_tokens" | "oauth_refresh_tokens",
  token: string,
  docoIds: string[],
  workspaceIds: string[],
  revoked = false,
) {
  await db.query(
    `INSERT INTO ${table}
       (token, client_id, user_id, granted_doco_ids, granted_workspace_ids, expires_at, revoked)
     VALUES ($1, 'doco_client_x', 'user_alice', $2, $3, now() + interval '1 day', $4)`,
    [token, docoIds, workspaceIds, revoked],
  );
}

async function revoked(table: string, token: string): Promise<boolean> {
  const r = await db.query<{ revoked: boolean }>(`SELECT revoked FROM ${table} WHERE token = $1`, [
    token,
  ]);
  return r.rows[0]?.revoked ?? false;
}

describe("revoke-broad-tokens migration (single-workspace rule)", () => {
  beforeEach(async () => {
    db = new PGlite();
    await db.exec(schemaSql); // fresh baseline (DO block runs, no tokens yet)

    await db.query("INSERT INTO users (id, data) VALUES ('user_alice', '{}')");
    await db.query(
      "INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ('doco_client_x', 'x', ARRAY['urn:ietf:wg:oauth:2.0:oob'])",
    );
    for (const [id, handle] of [
      [WS_A, "acme"],
      [WS_B, "beta"],
    ]) {
      await db.query("INSERT INTO workspaces (id, handle, name) VALUES ($1, $2, $2)", [id, handle]);
    }
    // doco_a1 in WS_A, doco_b1 in WS_B, doco_personal owned by the user.
    await db.query(
      "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ('doco_a1','a1',$1,$1,'{}')",
      [WS_A],
    );
    await db.query(
      "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ('doco_b1','b1',$1,$1,'{}')",
      [WS_B],
    );
    await db.query(
      "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ('doco_personal','p','user_alice',$1,'{}')",
      [WS_A],
    );

    // Narrow (must survive):
    await insertToken("oauth_access_tokens", "at_ws", [], [WS_A]);
    await insertToken("oauth_access_tokens", "at_doco", ["doco_a1"], []);
    await insertToken("oauth_access_tokens", "at_ws_plus_doco", ["doco_a1"], [WS_A]);
    await insertToken("oauth_access_tokens", "at_personal", ["doco_personal"], []);
    // Broad (must be revoked):
    await insertToken("oauth_access_tokens", "at_star", ["*"], []);
    await insertToken("oauth_access_tokens", "at_two_ws", [], [WS_A, WS_B]);
    await insertToken("oauth_access_tokens", "at_doco_other_ws", ["doco_b1"], [WS_A]);
    await insertToken("oauth_access_tokens", "at_two_docos", ["doco_a1", "doco_b1"], []);

    await insertToken("oauth_refresh_tokens", "rt_narrow", [], [WS_A]);
    await insertToken("oauth_refresh_tokens", "rt_two_ws", [], [WS_A, WS_B]);

    // A pending device authorization spanning two workspaces (must be deleted).
    await db.query(
      `INSERT INTO oauth_device_authorizations
         (device_code, user_code, client_id, status, granted_doco_ids, granted_workspace_ids, expires_at)
       VALUES ('dc_broad','CODE-BR0D','doco_client_x','pending', ARRAY[]::text[], $1, now() + interval '10 min')`,
      [[WS_A, WS_B]],
    );
    await db.query(
      `INSERT INTO oauth_device_authorizations
         (device_code, user_code, client_id, status, granted_doco_ids, granted_workspace_ids, expires_at)
       VALUES ('dc_narrow','CODE-N4RW','doco_client_x','pending', ARRAY[]::text[], $1, now() + interval '10 min')`,
      [[WS_A]],
    );

    // Re-apply the baseline (what the next boot/deploy does → runs the heal).
    await db.exec(schemaSql);
  });

  it("keeps single-workspace access tokens", async () => {
    expect(await revoked("oauth_access_tokens", "at_ws")).toBe(false);
    expect(await revoked("oauth_access_tokens", "at_doco")).toBe(false);
    expect(await revoked("oauth_access_tokens", "at_ws_plus_doco")).toBe(false);
    expect(await revoked("oauth_access_tokens", "at_personal")).toBe(false);
  });

  it("revokes '*' and multi-workspace access tokens", async () => {
    expect(await revoked("oauth_access_tokens", "at_star")).toBe(true);
    expect(await revoked("oauth_access_tokens", "at_two_ws")).toBe(true);
    expect(await revoked("oauth_access_tokens", "at_doco_other_ws")).toBe(true);
    expect(await revoked("oauth_access_tokens", "at_two_docos")).toBe(true);
  });

  it("revokes broad refresh tokens but keeps narrow ones", async () => {
    expect(await revoked("oauth_refresh_tokens", "rt_narrow")).toBe(false);
    expect(await revoked("oauth_refresh_tokens", "rt_two_ws")).toBe(true);
  });

  it("deletes pending broad device authorizations but keeps narrow ones", async () => {
    const rows = await db.query<{ device_code: string }>(
      "SELECT device_code FROM oauth_device_authorizations ORDER BY device_code",
    );
    expect(rows.rows.map((r) => r.device_code)).toEqual(["dc_narrow"]);
  });
});
