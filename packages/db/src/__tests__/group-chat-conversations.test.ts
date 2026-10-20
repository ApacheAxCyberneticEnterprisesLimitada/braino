// Señor Doco's channel introductions moved from group_chat_channel_intros into
// group_chat_conversations, which keeps a person's welcome and the quiet
// switch beside them. Production still has the old table, so re-applying
// schema.sql carries each channel over as introduced, when it was, and drops
// the old table.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

let db: PGlite;

describe("group_chat_channel_intros becomes group_chat_conversations", () => {
  beforeEach(async () => {
    db = await freshDb();
  });

  it("carries every introduced channel over and drops the old table", async () => {
    await db.exec(`
      CREATE TABLE group_chat_channel_intros (
        provider      text NOT NULL,
        workspace_id  text NOT NULL,
        channel_id    text NOT NULL,
        introduced_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (provider, workspace_id, channel_id)
      );
      INSERT INTO group_chat_channel_intros (provider, workspace_id, channel_id, introduced_at)
      VALUES ('slack', 'T1', 'C1', '2026-10-01T12:00:00Z'),
             ('slack', 'T2', 'C9', '2026-10-02T12:00:00Z');
    `);

    await db.exec(schemaSql);

    const old = await db.query("SELECT to_regclass('public.group_chat_channel_intros') AS reg");
    expect((old.rows[0] as { reg: string | null }).reg).toBeNull();
    const rows = await db.query(
      `SELECT provider, workspace_id, conversation_id, introduced_at, quiet_at
         FROM group_chat_conversations ORDER BY workspace_id`,
    );
    expect(rows.rows).toEqual([
      {
        provider: "slack",
        workspace_id: "T1",
        conversation_id: "C1",
        introduced_at: new Date("2026-10-01T12:00:00Z"),
        quiet_at: null,
      },
      {
        provider: "slack",
        workspace_id: "T2",
        conversation_id: "C9",
        introduced_at: new Date("2026-10-02T12:00:00Z"),
        quiet_at: null,
      },
    ]);
  });
});
