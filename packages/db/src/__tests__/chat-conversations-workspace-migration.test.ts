// chat_conversations gains a workspace_id so Señor Doco threads can be
// hard-scoped to one Workspace. schema.sql is re-applied every boot, so the
// column is added idempotently via `ALTER ... ADD COLUMN IF NOT EXISTS`. This
// test simulates a pre-migration DB (column dropped, an existing thread row),
// re-applies the baseline, and asserts the column is restored, pre-existing
// threads are left unassigned (NULL), and the ON DELETE SET NULL FK unassigns
// rather than deletes a thread when its Workspace is removed.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, schemaSql } from "./fresh-db.js";

let db: PGlite;

async function hasWorkspaceColumn(): Promise<boolean> {
  const r = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'chat_conversations' AND column_name = 'workspace_id'`,
  );
  return r.rows[0].n === 1;
}

async function workspaceIdOf(conversationId: string): Promise<string | null> {
  const r = await db.query<{ workspace_id: string | null }>(
    "SELECT workspace_id FROM chat_conversations WHERE id = $1",
    [conversationId],
  );
  return r.rows[0].workspace_id;
}

describe("chat_conversations workspace_id migration", () => {
  beforeEach(async () => {
    db = await freshDb();
    await db.query("INSERT INTO users (id, data) VALUES ('user_alice', '{}')");
  });

  it("restores workspace_id on re-apply and leaves existing threads unassigned", async () => {
    // Simulate a pre-migration DB: a thread created before the column existed.
    await db.exec("ALTER TABLE chat_conversations DROP COLUMN workspace_id");
    await db.query(
      "INSERT INTO chat_conversations (id, user_id, title) VALUES ('conv_old', 'user_alice', 'Older thread')",
    );
    expect(await hasWorkspaceColumn()).toBe(false);

    await db.exec(schemaSql); // the migration boot

    expect(await hasWorkspaceColumn()).toBe(true);
    expect(await workspaceIdOf("conv_old")).toBeNull();
  });

  it("is idempotent across repeated boots", async () => {
    await db.exec(schemaSql);
    await db.exec(schemaSql);
    expect(await hasWorkspaceColumn()).toBe(true);
  });

  it("unassigns (ON DELETE SET NULL) a thread when its Workspace is removed", async () => {
    await db.query(
      "INSERT INTO workspaces (id, handle, name, constitution) VALUES ('workspace_x', 'x', 'X', '')",
    );
    await db.query(
      "INSERT INTO chat_conversations (id, user_id, workspace_id) VALUES ('conv_x','user_alice','workspace_x')",
    );
    expect(await workspaceIdOf("conv_x")).toBe("workspace_x");

    await db.query("DELETE FROM workspaces WHERE id = 'workspace_x'");

    // Thread survives, just unassigned — chat history is never destroyed.
    expect(await workspaceIdOf("conv_x")).toBeNull();
  });
});
