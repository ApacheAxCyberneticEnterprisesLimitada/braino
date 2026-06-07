// Chat teams are now bound to a single Doco workspace. The deploy that adds
// the binding column also revokes every pre-existing personal link ONCE (users
// re-link after their team is bound). schema.sql is re-applied every boot, so
// the revoke is guarded on the binding column not yet existing. This test
// simulates the pre-binding shape (column dropped), re-applies the baseline,
// and asserts: links revoked once, column restored, and a re-link survives a
// later boot.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, schemaSql } from "./fresh-db.js";

let db: PGlite;

async function linkCount(): Promise<number> {
  const r = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM group_chat_user_links");
  return r.rows[0].n;
}

async function hasBindingColumn(): Promise<boolean> {
  const r = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'group_chat_installations' AND column_name = 'doco_workspace_id'`,
  );
  return r.rows[0].n === 1;
}

async function seedLink(chatUser: string) {
  await db.query(
    `INSERT INTO group_chat_user_links (id, provider, workspace_id, chat_user_id, user_id)
     VALUES ($1, 'slack', 'T_TEAM', $2, 'user_alice')`,
    [`gcul_${chatUser}`, chatUser],
  );
}

describe("slack team→workspace binding migration (revoke personal links once)", () => {
  beforeEach(async () => {
    db = await freshDb();
    await db.query("INSERT INTO users (id, data) VALUES ('user_alice', '{}')");
    await db.query(
      "INSERT INTO group_chat_installations (id, provider, workspace_id) VALUES ('gci_1','slack','T_TEAM')",
    );
    await seedLink("U1");
    await seedLink("U2");
    // Simulate the pre-binding shape: drop the column the migration introduces.
    await db.query("ALTER TABLE group_chat_installations DROP COLUMN doco_workspace_id");
  });

  it("a fresh DB keeps its links (column ships with CREATE TABLE → guard skips)", async () => {
    // Re-add the column to mimic a fresh DB, then re-apply: no revoke.
    await db.exec("ALTER TABLE group_chat_installations ADD COLUMN doco_workspace_id text");
    await db.exec(schemaSql);
    expect(await linkCount()).toBe(2);
  });

  it("revokes pre-existing links exactly once, then restores the column", async () => {
    expect(await hasBindingColumn()).toBe(false);
    await db.exec(schemaSql); // the migration boot
    expect(await linkCount()).toBe(0); // revoked
    expect(await hasBindingColumn()).toBe(true); // column restored

    // A later re-link must survive subsequent boots (no repeat revoke).
    await seedLink("U3");
    await db.exec(schemaSql);
    expect(await linkCount()).toBe(1);
  });
});
