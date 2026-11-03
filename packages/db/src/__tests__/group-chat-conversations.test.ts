// group_chat_conversations keeps what Señor Doco said once in each Slack
// conversation: a channel's introduction, a person's welcome, and the threads
// he is done with. Two migrations bring an older database to that shape when
// schema.sql is applied again:
// - Channel introductions move in from group_chat_channel_intros, which is
//   dropped.
// - Quieting him from Slack is gone (Alexander, 2026-11-03: "No management
//   options in Slack other than the button to go to Doco."). A quieted
//   channel keeps him as quiet through the switches on doco.to: the Times off
//   where it was his channel, and no watching for decisions there. quiet_at
//   lives on only as a thread's closed_at.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

describe("group_chat_channel_intros becomes group_chat_conversations", () => {
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
      `SELECT provider, workspace_id, conversation_id, introduced_at, closed_at
         FROM group_chat_conversations ORDER BY workspace_id`,
    );
    expect(rows.rows).toEqual([
      {
        provider: "slack",
        workspace_id: "T1",
        conversation_id: "C1",
        introduced_at: new Date("2026-10-01T12:00:00Z"),
        closed_at: null,
      },
      {
        provider: "slack",
        workspace_id: "T2",
        conversation_id: "C9",
        introduced_at: new Date("2026-10-02T12:00:00Z"),
        closed_at: null,
      },
    ]);
  });
});

describe("quieting from Slack becomes the switches on doco.to", () => {
  it("turns off the Times and watching where he was quieted, and keeps only closed threads", async () => {
    await db.exec(`
      INSERT INTO workspaces (id, handle, name) VALUES ('workspace_1', 'torre', 'Torre');
      INSERT INTO collections (id, handle, owner_id, workspace_id, data)
        VALUES ('collection_slack', 'torre-slack', 'workspace_1', 'workspace_1', '{}');
      INSERT INTO group_chat_installations
        (id, provider, workspace_id, workspace_name, doco_workspace_id, default_channel_id)
        VALUES ('gci_1', 'slack', 'T1', 'Torre', 'workspace_1', 'C_TIMES'),
               ('gci_2', 'slack', 'T2', 'Other', 'workspace_1', 'C_TIMES');
      INSERT INTO group_chat_mirrors (collection_id, installation_id, team_domain, history_since, consented_at)
        VALUES ('collection_slack', 'gci_1', 'torre', '2026-01-01', '2026-08-01');
      INSERT INTO group_chat_channels (collection_id, channel_id, name, decision_offers) VALUES
        ('collection_slack', 'C_TIMES', 'doco-times', true),
        ('collection_slack', 'C_ENG', 'eng', true),
        ('collection_slack', 'C_PRODUCT', 'product', true);
      ALTER TABLE group_chat_conversations RENAME COLUMN closed_at TO quiet_at;
      INSERT INTO group_chat_conversations (provider, workspace_id, conversation_id, introduced_at, quiet_at)
      VALUES ('slack', 'T1', 'C_TIMES', '2026-10-01', '2026-10-31'),
             ('slack', 'T1', 'C_ENG', NULL, '2026-10-31'),
             ('slack', 'T1', 'U_ANA', '2026-10-01', '2026-10-31'),
             ('slack', 'T1', 'C_PRODUCT/1700000000.000100', '2026-10-02', '2026-10-03'),
             ('slack', 'T1', 'C_PRODUCT/1700000000.000200', '2026-10-02', NULL);
    `);

    await db.exec(schemaSql);

    const teams = await db.query(
      "SELECT workspace_id, digest FROM group_chat_installations ORDER BY workspace_id",
    );
    expect(teams.rows).toEqual([
      { workspace_id: "T1", digest: "off" },
      { workspace_id: "T2", digest: "daily" },
    ]);
    const channels = await db.query(
      "SELECT channel_id, decision_offers FROM group_chat_channels ORDER BY channel_id",
    );
    expect(channels.rows).toEqual([
      { channel_id: "C_ENG", decision_offers: false },
      { channel_id: "C_PRODUCT", decision_offers: true },
      { channel_id: "C_TIMES", decision_offers: false },
    ]);
    const conversations = await db.query(
      `SELECT conversation_id, introduced_at, closed_at
         FROM group_chat_conversations ORDER BY conversation_id`,
    );
    expect(conversations.rows).toEqual([
      { conversation_id: "C_ENG", introduced_at: null, closed_at: null },
      {
        conversation_id: "C_PRODUCT/1700000000.000100",
        introduced_at: new Date("2026-10-02T00:00:00Z"),
        closed_at: new Date("2026-10-03T00:00:00Z"),
      },
      {
        conversation_id: "C_PRODUCT/1700000000.000200",
        introduced_at: new Date("2026-10-02T00:00:00Z"),
        closed_at: null,
      },
      {
        conversation_id: "C_TIMES",
        introduced_at: new Date("2026-10-01T00:00:00Z"),
        closed_at: null,
      },
      {
        conversation_id: "U_ANA",
        introduced_at: new Date("2026-10-01T00:00:00Z"),
        closed_at: null,
      },
    ]);
  });
});
