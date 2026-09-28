// Embedding rows follow their entity: schema.sql's AFTER DELETE triggers drop
// the chunks of a node, a policy, a Notion page or a Slack message when it
// goes, whether deleted directly or through a cascade.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { vectorLiteral } from "../embeddings.js";
import { freshDb } from "./fresh-db.js";

let db: PGlite;

async function embedded(): Promise<string[]> {
  const r = await db.query<{ entity_id: string }>(
    "SELECT DISTINCT entity_id FROM embeddings ORDER BY entity_id",
  );
  return r.rows.map((row) => row.entity_id);
}

beforeEach(async () => {
  db = await freshDb();
  await db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('ws', 'ws', 'WS');
    INSERT INTO docos (id, handle, owner_id, workspace_id, data)
      VALUES ('doco_1', 'd', 'ws', 'ws', '{}'::jsonb);
    INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose)
      VALUES ('decision_1', 'doco_1', 'decision', 'active', 'Ship it');
    INSERT INTO policies (id, doco_id, kind, data)
      VALUES ('policy_1', 'doco_1', 'suggestion', '{}'::jsonb);
    INSERT INTO notion_mirrors (doco_id, workspace_id, workspace_name, bot_id, access_token, consented_at)
      VALUES ('doco_1', 'ws_notion', 'Acme', 'bot_1', 'enc', now());
    INSERT INTO notion_pages (doco_id, page_id, object, url)
      VALUES ('doco_1', 'page_1', 'page', 'https://www.notion.so/page1');
    INSERT INTO group_chat_installations (id, provider, workspace_id, doco_workspace_id)
      VALUES ('gci_1', 'slack', 'T1', 'ws');
    INSERT INTO group_chat_mirrors (doco_id, installation_id, team_domain, history_since, consented_at)
      VALUES ('doco_1', 'gci_1', 'acme', now(), now());
    INSERT INTO group_chat_channels (doco_id, channel_id, name, joined_at)
      VALUES ('doco_1', 'C1', 'general', now());
    INSERT INTO group_chat_messages (doco_id, channel_id, ts, text, posted_at)
      VALUES ('doco_1', 'C1', '1700000000.000100', 'hi', now());
  `);
  await db.query(
    `INSERT INTO embeddings
       (doco_id, source, entity_id, chunk_index, model_id, content_hash, chunk_text, embedding)
     VALUES
       ('doco_1', 'node', 'decision_1', 0, 'm', 'h', 'Ship', $1::vector),
       ('doco_1', 'node', 'decision_1', 1, 'm', 'h', 'it', $1::vector),
       ('doco_1', 'node', 'policy_1', 0, 'm', 'h', 'Policy', $1::vector),
       ('doco_1', 'notion', 'page_1', 0, 'm', 'h', 'Page', $1::vector),
       ('doco_1', 'slack', 'C1:1700000000.000100', 0, 'm', 'h', 'hi', $1::vector)`,
    [vectorLiteral([1, 0, 0])],
  );
});

describe("embeddings follow their entity", () => {
  it("drops a deleted node's chunks, and only those", async () => {
    await db.query("DELETE FROM nodes WHERE id = 'decision_1'");
    expect(await embedded()).toEqual(["C1:1700000000.000100", "page_1", "policy_1"]);
  });

  it("drops a deleted policy's chunks", async () => {
    await db.query("DELETE FROM policies WHERE id = 'policy_1'");
    expect(await embedded()).not.toContain("policy_1");
  });

  it("drops a Notion page's chunks, also when the mirror is stopped", async () => {
    await db.query("DELETE FROM notion_mirrors WHERE doco_id = 'doco_1'");
    expect(await embedded()).toEqual(["C1:1700000000.000100", "decision_1", "policy_1"]);
  });

  it("drops a Slack message's chunks, also when its channel goes", async () => {
    await db.query("DELETE FROM group_chat_channels WHERE channel_id = 'C1'");
    expect(await embedded()).toEqual(["decision_1", "page_1", "policy_1"]);
  });

  it("drops everything with the Doco", async () => {
    await db.query("DELETE FROM docos WHERE id = 'doco_1'");
    expect(await embedded()).toEqual([]);
  });
});
