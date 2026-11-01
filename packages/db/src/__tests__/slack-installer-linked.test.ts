// The Slack user who approved Señor Doco's install is the Doco owner who
// started it, and an install links the two (lib/slack.server.ts). Teams
// installed before that are linked on boot, so their installer can press
// Manage in Slack as an owner without linking first (Alexander, 2026-11-01).
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

let db: PGlite;

async function links(): Promise<string[]> {
  const r = await db.query<{ workspace_id: string; chat_user_id: string; user_id: string }>(
    `SELECT workspace_id, chat_user_id, user_id FROM group_chat_user_links
      ORDER BY workspace_id, chat_user_id`,
  );
  return r.rows.map((row) => `${row.workspace_id}/${row.chat_user_id}=${row.user_id}`);
}

describe("Slack installers are linked to the owner who installed", () => {
  beforeEach(async () => {
    db = await freshDb();
    await db.exec(`
      INSERT INTO users (id, username, data) VALUES ('user_ana', 'ana', '{}'), ('user_bo', 'bo', '{}');
      INSERT INTO group_chat_installations
        (id, provider, workspace_id, installed_by_chat_user_id, installed_by_user_id)
      VALUES
        ('gci_1', 'slack', 'T1', 'U_ANA', 'user_ana'),
        ('gci_2', 'slack', 'T2', 'U_BO', 'user_bo'),
        ('gci_3', 'slack', 'T3', NULL, 'user_ana'),
        ('gci_4', 'slack', 'T4', 'U_GONE', NULL);
      INSERT INTO group_chat_user_links (id, provider, workspace_id, chat_user_id, user_id)
      VALUES ('gcul_bo', 'slack', 'T2', 'U_BO', 'user_bo');
    `);
  });

  it("links each installer Slack and Doco both name, once, on every boot", async () => {
    await db.exec(schemaSql);
    await db.exec(schemaSql);

    expect(await links()).toEqual(["T1/U_ANA=user_ana", "T2/U_BO=user_bo"]);
  });
});
