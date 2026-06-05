// chat_conversations gains a doco_id so every in-app Señor Doco chat binds to
// one Doco (1:1 per user). schema.sql is re-applied every boot, so the column
// is added idempotently via `ALTER ... ADD COLUMN IF NOT EXISTS`, and a partial
// unique index enforces "a Doco can only have a chat". This test simulates a
// pre-migration DB, re-applies the baseline, and asserts: the column is
// restored leaving existing threads Doco-less (NULL); the unique index rejects
// a second live chat for the same (user, Doco); and ON DELETE SET NULL
// preserves chat history (orphaning the thread) when the Doco is removed.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

let db: PGlite;

async function hasDocoColumn(): Promise<boolean> {
  const r = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'chat_conversations' AND column_name = 'doco_id'`,
  );
  return r.rows[0].n === 1;
}

async function docoIdOf(conversationId: string): Promise<string | null> {
  const r = await db.query<{ doco_id: string | null }>(
    "SELECT doco_id FROM chat_conversations WHERE id = $1",
    [conversationId],
  );
  return r.rows[0].doco_id;
}

async function seedDoco(): Promise<void> {
  await db.query(
    "INSERT INTO workspaces (id, handle, name, constitution, data) VALUES ('workspace_x','x','X','','{}')",
  );
  await db.query(
    `INSERT INTO docos (id, handle, owner_id, workspace_id, visibility, data)
     VALUES ('doco_x','x','workspace_x','workspace_x','private','{}')`,
  );
}

describe("chat_conversations doco_id migration", () => {
  beforeEach(async () => {
    db = new PGlite();
    await db.exec(schemaSql); // fresh baseline — column present via CREATE TABLE
    await db.query("INSERT INTO users (id, data) VALUES ('user_alice', '{}')");
  });

  it("restores doco_id on re-apply and leaves existing threads Doco-less", async () => {
    await db.exec("ALTER TABLE chat_conversations DROP COLUMN doco_id");
    await db.query(
      "INSERT INTO chat_conversations (id, user_id, title) VALUES ('conv_old', 'user_alice', 'Older thread')",
    );
    expect(await hasDocoColumn()).toBe(false);

    await db.exec(schemaSql); // the migration boot

    expect(await hasDocoColumn()).toBe(true);
    expect(await docoIdOf("conv_old")).toBeNull();
  });

  it("is idempotent across repeated boots", async () => {
    await db.exec(schemaSql);
    await db.exec(schemaSql);
    expect(await hasDocoColumn()).toBe(true);
  });

  it("rejects a second live chat for the same (user, Doco)", async () => {
    await seedDoco();
    await db.query(
      "INSERT INTO chat_conversations (id, user_id, doco_id) VALUES ('conv_a','user_alice','doco_x')",
    );
    await expect(
      db.query(
        "INSERT INTO chat_conversations (id, user_id, doco_id) VALUES ('conv_b','user_alice','doco_x')",
      ),
    ).rejects.toThrow();
  });

  it("exempts Doco-less threads from the unique index", async () => {
    // Two legacy/orphaned (doco_id NULL) threads for one user must coexist.
    await db.query("INSERT INTO chat_conversations (id, user_id) VALUES ('conv_n1','user_alice')");
    await db.query("INSERT INTO chat_conversations (id, user_id) VALUES ('conv_n2','user_alice')");
    const r = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM chat_conversations WHERE user_id = 'user_alice'",
    );
    expect(r.rows[0].n).toBe("2");
  });

  it("orphans (ON DELETE SET NULL) a thread when its Doco is removed", async () => {
    await seedDoco();
    await db.query(
      "INSERT INTO chat_conversations (id, user_id, doco_id) VALUES ('conv_x','user_alice','doco_x')",
    );
    expect(await docoIdOf("conv_x")).toBe("doco_x");

    await db.query("DELETE FROM docos WHERE id = 'doco_x'");

    // Thread survives, just orphaned — chat history is never destroyed.
    expect(await docoIdOf("conv_x")).toBeNull();
  });
});
