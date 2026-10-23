// What a person is called is users.name (Alexander, 2026-10-23: bylines like
// "Alex Torrenegra via Claude", each linked to the person's profile). On the
// boot that adds the column, a person who linked their Slack account takes the
// real name a Slack copy of that team lists for them; everyone else writes
// theirs on their profile, and a later boot never overwrites it.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

let db: PGlite;

async function names(): Promise<Record<string, string | null>> {
  const r = await db.query<{ id: string; name: string | null }>(
    "SELECT id, name FROM users ORDER BY id",
  );
  return Object.fromEntries(r.rows.map((row) => [row.id, row.name]));
}

describe("users.name", () => {
  beforeEach(async () => {
    db = await freshDb();
    // A database from before the column: Ana linked Slack, where the team's
    // copy lists her; Bo linked a team no collection copies; Cy linked nothing.
    await db.exec(`
      ALTER TABLE users DROP COLUMN name;
      INSERT INTO users (id, username, data) VALUES
        ('user_ana', 'ana', '{}'), ('user_bo', 'bo', '{}'), ('user_cy', 'cy', '{}');
      INSERT INTO workspaces (id, handle, name) VALUES ('workspace_acme', 'acme', 'Acme');
      INSERT INTO collections (id, handle, owner_id, workspace_id, visibility, data) VALUES
        ('collection_slack', 'acme-slack', 'workspace_acme', 'workspace_acme', 'private', '{}');
      INSERT INTO group_chat_installations (id, provider, workspace_id) VALUES
        ('inst_acme', 'slack', 'T_ACME'), ('inst_other', 'slack', 'T_OTHER');
      INSERT INTO group_chat_mirrors
        (collection_id, installation_id, team_domain, history_since, consented_at)
        VALUES ('collection_slack', 'inst_acme', 'acme.slack.com', now(), now());
      INSERT INTO group_chat_members (collection_id, chat_user_id, real_name, is_bot) VALUES
        ('collection_slack', 'U_ANA', ' Ana Ruiz ', false),
        ('collection_slack', 'U_BOT', 'Señor Doco', true);
      INSERT INTO group_chat_user_links (id, provider, workspace_id, chat_user_id, user_id) VALUES
        ('link_ana', 'slack', 'T_ACME', 'U_ANA', 'user_ana'),
        ('link_bo', 'slack', 'T_OTHER', 'U_BO', 'user_bo');
    `);
  });

  it("takes each linked person's real name from Slack on the boot that adds it", async () => {
    await db.exec(schemaSql);
    expect(await names()).toEqual({ user_ana: "Ana Ruiz", user_bo: null, user_cy: null });
  });

  it("keeps the names people wrote on every later boot", async () => {
    await db.exec(schemaSql);
    await db.exec("UPDATE users SET name = 'Ana María Ruiz' WHERE id = 'user_ana'");
    await db.exec(schemaSql);
    expect((await names()).user_ana).toBe("Ana María Ruiz");
  });
});
