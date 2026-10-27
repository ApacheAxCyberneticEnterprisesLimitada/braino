// Embedding rows follow their entity: schema.sql's AFTER DELETE triggers drop
// the chunks of a node, a policy, a Notion page, a Slack message or a Google
// Drive file when it goes, whether deleted directly or through a cascade.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { embeddingLiteral } from "../embeddings.js";
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
    INSERT INTO collections (id, handle, owner_id, workspace_id, data)
      VALUES ('collection_1', 'd', 'ws', 'ws', '{}'::jsonb);
    INSERT INTO nodes (id, collection_id, node_type, lifecycle, prose)
      VALUES ('decision_1', 'collection_1', 'decision', 'active', 'Ship it');
    INSERT INTO policies (id, collection_id, kind, data)
      VALUES ('policy_1', 'collection_1', 'suggestion', '{}'::jsonb);
    INSERT INTO notion_mirrors (collection_id, workspace_id, workspace_name, bot_id, access_token, consented_at)
      VALUES ('collection_1', 'ws_notion', 'Acme', 'bot_1', 'enc', now());
    INSERT INTO notion_pages (collection_id, page_id, object, url)
      VALUES ('collection_1', 'page_1', 'page', 'https://www.notion.so/page1');
    INSERT INTO group_chat_installations (id, provider, workspace_id, doco_workspace_id)
      VALUES ('gci_1', 'slack', 'T1', 'ws');
    INSERT INTO group_chat_mirrors (collection_id, installation_id, team_domain, history_since, consented_at)
      VALUES ('collection_1', 'gci_1', 'acme', now(), now());
    INSERT INTO group_chat_channels (collection_id, channel_id, name, joined_at)
      VALUES ('collection_1', 'C1', 'general', now());
    INSERT INTO group_chat_messages (collection_id, channel_id, ts, text, posted_at)
      VALUES ('collection_1', 'C1', '1700000000.000100', 'hi', now());
    INSERT INTO google_drive_mirrors
      (collection_id, account_email, access_token, refresh_token, consented_at, change_page_token)
      VALUES ('collection_1', 'ana@acme.test', 'enc', 'enc', now(), '1');
    INSERT INTO google_drive_roots (collection_id, root_id, kind, name)
      VALUES ('collection_1', 'drive_1', 'drive', 'Engineering');
    INSERT INTO google_drive_files (collection_id, file_id, root_id, kind, mime_type)
      VALUES ('collection_1', 'file_1', 'drive_1', 'doc', 'application/vnd.google-apps.document');
  `);
  await db.query(
    `INSERT INTO embeddings
       (collection_id, source, entity_id, chunk_index, model_id, content_hash, chunk_text, embedding)
     VALUES
       ('collection_1', 'node', 'decision_1', 0, 'm', 'h', 'Ship', $1::real[]),
       ('collection_1', 'node', 'decision_1', 1, 'm', 'h', 'it', $1::real[]),
       ('collection_1', 'node', 'policy_1', 0, 'm', 'h', 'Policy', $1::real[]),
       ('collection_1', 'notion', 'page_1', 0, 'm', 'h', 'Page', $1::real[]),
       ('collection_1', 'slack', 'C1:1700000000.000100', 0, 'm', 'h', 'hi', $1::real[]),
       ('collection_1', 'google_drive', 'file_1', 0, 'm', 'h', 'Plan', $1::real[])`,
    [embeddingLiteral([1, 0, 0])],
  );
});

describe("embeddings follow their entity", () => {
  it("drops a deleted node's chunks, and only those", async () => {
    await db.query("DELETE FROM nodes WHERE id = 'decision_1'");
    expect(await embedded()).toEqual(["C1:1700000000.000100", "file_1", "page_1", "policy_1"]);
  });

  it("drops a deleted policy's chunks", async () => {
    await db.query("DELETE FROM policies WHERE id = 'policy_1'");
    expect(await embedded()).not.toContain("policy_1");
  });

  it("drops a Notion page's chunks, also when the mirror is stopped", async () => {
    await db.query("DELETE FROM notion_mirrors WHERE collection_id = 'collection_1'");
    expect(await embedded()).toEqual(["C1:1700000000.000100", "decision_1", "file_1", "policy_1"]);
  });

  it("drops a Slack message's chunks, also when its channel goes", async () => {
    await db.query("DELETE FROM group_chat_channels WHERE channel_id = 'C1'");
    expect(await embedded()).toEqual(["decision_1", "file_1", "page_1", "policy_1"]);
  });

  it("drops a Drive file's chunks, also when the mirror is stopped", async () => {
    await db.query("DELETE FROM google_drive_mirrors WHERE collection_id = 'collection_1'");
    expect(await embedded()).toEqual(["C1:1700000000.000100", "decision_1", "page_1", "policy_1"]);
  });

  it("drops everything with the collection", async () => {
    await db.query("DELETE FROM collections WHERE id = 'collection_1'");
    expect(await embedded()).toEqual([]);
  });
});
