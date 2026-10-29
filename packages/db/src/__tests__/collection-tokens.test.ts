// How many tokens each collection holds, four characters a token, by where
// they come from (collection_tokens, recounted by refresh_collection_tokens()),
// so every brief and search can say how many it searched: its live records'
// prose and what its copies of Slack (but the channels left out of the copy),
// Notion, Google Drive and code hold. The boot that adds
// activity_days.tokens gives every past brief its searched_tokens: what the
// workspace's collections the asker could read held, as they stood when the
// brief's day began, without code, which the brief doesn't search. It then
// clears the rollup, so its next run counts every day again, tokens and all.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

let db: PGlite;

/** `n` tokens of text. */
const text = (n: number) => `'${"x".repeat(n * 4)}'`;

beforeEach(async () => {
  db = await freshDb();
  await db.exec(`
    INSERT INTO users (id, username, data) VALUES
      ('user_ana', 'ana', '{}'), ('user_bo', 'bo', '{}'), ('user_cy', 'cy', '{}');
    INSERT INTO workspaces (id, handle, name) VALUES
      ('workspace_acme', 'acme', 'Acme'), ('workspace_beta', 'beta', 'Beta');
    INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ('workspace_acme', 'user_ana', 'owner');
    INSERT INTO collections (id, handle, owner_id, workspace_id, visibility, data, created_at, deleted_at) VALUES
      ('collection_notes', 'notes', 'workspace_acme', 'workspace_acme', 'private', '{}', '2026-10-01', NULL),
      ('collection_docs', 'docs', 'workspace_acme', 'workspace_acme', 'public', '{}', '2026-10-01', NULL),
      ('collection_late', 'late', 'workspace_acme', 'workspace_acme', 'private', '{}', '2026-10-20', NULL),
      ('collection_gone', 'gone', 'workspace_acme', 'workspace_acme', 'private', '{}', '2026-10-01', '2026-10-06'),
      ('collection_beta', 'beta', 'workspace_beta', 'workspace_beta', 'public', '{}', '2026-10-01', NULL);
    INSERT INTO collection_users (collection_id, user_id, role) VALUES ('collection_notes', 'user_bo', 'reader');

    INSERT INTO nodes (id, collection_id, node_type, lifecycle, prose, created_at) VALUES
      ('decision_1', 'collection_notes', 'decision', 'active', ${text(100)}, '2026-10-01T10:00:00Z'),
      ('decision_2', 'collection_notes', 'decision', 'active', ${text(20)}, '2026-10-10T10:00:00Z'),
      ('decision_3', 'collection_notes', 'decision', 'retired', ${text(1000)}, '2026-10-01T10:00:00Z'),
      ('reference_1', 'collection_docs', 'reference', 'active', ${text(7)}, '2026-10-02T10:00:00Z'),
      ('reference_2', 'collection_late', 'reference', 'active', ${text(3)}, '2026-10-20T10:00:00Z'),
      ('reference_3', 'collection_gone', 'reference', 'active', ${text(9)}, '2026-10-01T10:00:00Z'),
      ('reference_4', 'collection_beta', 'reference', 'active', ${text(11)}, '2026-10-01T10:00:00Z');

    -- A Slack copy consented to on 3 October, with a year of history.
    INSERT INTO group_chat_installations (id, provider, workspace_id, doco_workspace_id)
      VALUES ('gci_1', 'slack', 'T1', 'workspace_acme');
    INSERT INTO group_chat_mirrors (collection_id, installation_id, team_domain, history_since, consented_at)
      VALUES ('collection_notes', 'gci_1', 'acme', '2025-01-01', '2026-10-03T09:00:00Z');
    INSERT INTO group_chat_channels (collection_id, channel_id, name, joined_at, excluded) VALUES
      ('collection_notes', 'C1', 'general', '2026-10-03', false),
      ('collection_notes', 'C2', 'left-out', '2026-10-03', true);
    INSERT INTO group_chat_messages (collection_id, channel_id, ts, text, posted_at) VALUES
      ('collection_notes', 'C1', '1.0', ${text(1000)}, '2025-06-01T00:00:00Z'),
      ('collection_notes', 'C1', '2.0', ${text(200)}, '2026-10-12T00:00:00Z'),
      ('collection_notes', 'C2', '3.0', ${text(300)}, '2026-10-02T00:00:00Z');
    -- A Notion copy consented to on 4 October.
    INSERT INTO notion_mirrors (collection_id, workspace_id, workspace_name, bot_id, access_token, consented_at)
      VALUES ('collection_notes', 'n1', 'Acme', 'bot_1', 'enc', '2026-10-04T09:00:00Z');
    INSERT INTO notion_pages (collection_id, page_id, object, url, plain_text, created_time) VALUES
      ('collection_notes', 'p1', 'page', 'https://www.notion.so/p1', ${text(50)}, '2024-01-01T00:00:00Z');
    -- A Google Drive copy consented to on 4 October.
    INSERT INTO google_drive_mirrors
      (collection_id, domain, admin_email, consented_at)
      VALUES ('collection_notes', 'acme.test', 'admin@acme.test', '2026-10-04T09:00:00Z');
    INSERT INTO google_drive_roots (collection_id, root_id, kind, name, reads_as)
      VALUES ('collection_notes', 'drive_1', 'drive', 'Engineering', 'ana@acme.test');
    INSERT INTO google_drive_files (collection_id, file_id, root_id, kind, mime_type, plain_text, modified_time)
      VALUES ('collection_notes', 'f1', 'drive_1', 'doc', 'text/plain', ${text(5)}, '2026-10-01T00:00:00Z');
    -- Code, which a search reads and the brief doesn't.
    INSERT INTO code_files (collection_id, repo, path, sha, size, content)
      VALUES ('collection_notes', 'acme/app', 'a.ts', 'sha1', 8000, ${text(2000)});
  `);
});

async function sizes(): Promise<Record<string, number>> {
  const { rows } = await db.query<{ key: string; tokens: string | number }>(
    "SELECT collection_id || ' ' || source AS key, tokens FROM collection_tokens ORDER BY key",
  );
  return Object.fromEntries(rows.map((r) => [r.key, Number(r.tokens)]));
}

describe("each collection's tokens", () => {
  it("counts what its live records and the channels, pages and files it copies hold", async () => {
    await db.exec("SELECT refresh_collection_tokens()");
    expect(await sizes()).toEqual({
      "collection_beta records": 11,
      "collection_docs records": 7,
      "collection_gone records": 9,
      "collection_late records": 3,
      "collection_notes code": 2000,
      "collection_notes google_drive": 5,
      "collection_notes notion": 50,
      "collection_notes records": 120,
      "collection_notes slack": 1200,
    });
  });

  it("recounts from scratch: what is gone stops counting", async () => {
    await db.exec("SELECT refresh_collection_tokens()");
    await db.exec(`
      DELETE FROM code_files;
      UPDATE nodes SET lifecycle = 'retired' WHERE id = 'decision_2';
      SELECT refresh_collection_tokens();
    `);
    const after = await sizes();
    expect(after["collection_notes code"]).toBeUndefined();
    expect(after["collection_notes records"]).toBe(100);
  });
});

describe("the boot that adds activity_days.tokens", () => {
  /** A database from before the column, with a brief logged at `at` by
   *  `actor` (a hook token's when null) in `workspace`. */
  async function brief(id: number, workspace: string, actor: string | null, at: string) {
    await db.query(
      `INSERT INTO query_events (id, at, actor, workspace_id, source, metadata)
       VALUES ($1, $2, $3, $4, 'api', $5)`,
      [
        id,
        at,
        actor,
        workspace,
        JSON.stringify({ brief_id: `brief_${id}`, ...(actor ? {} : { auth: "bearer" }) }),
      ],
    );
  }

  async function searched(): Promise<Record<number, number | null>> {
    const { rows } = await db.query<{ id: number; tokens: number | null }>(
      "SELECT id::int, (metadata->>'searched_tokens')::int AS tokens FROM query_events ORDER BY id",
    );
    return Object.fromEntries(rows.map((r) => [r.id, r.tokens]));
  }

  beforeEach(async () => {
    await db.exec(`
      ALTER TABLE activity_days DROP COLUMN tokens;
      INSERT INTO activity_days (day, log, workspace_id, n, last_at)
        VALUES ('2026-10-05', 'queries', 'workspace_acme', 3, '2026-10-05T12:00:00Z');
      INSERT INTO activity_rollup (through) VALUES ('2026-10-27');
    `);
    // 5 October: the member's own brief, a hook token's, an outsider's
    // with a grant and one without, and one in the other workspace.
    await brief(1, "workspace_acme", "user_ana", "2026-10-05T12:00:00Z");
    await brief(2, "workspace_acme", null, "2026-10-05T13:00:00Z");
    await brief(3, "workspace_acme", "user_bo", "2026-10-05T14:00:00Z");
    await brief(4, "workspace_acme", "user_cy", "2026-10-05T15:00:00Z");
    await brief(5, "workspace_beta", "user_ana", "2026-10-05T16:00:00Z");
    // 25 October: the member again, once the late collection, the second
    // decision and the newer Slack message are in and the gone one is gone.
    await brief(6, "workspace_acme", "user_ana", "2026-10-25T12:00:00Z");
    // A query that is not a brief.
    await db.query(
      `INSERT INTO query_events (id, at, actor, workspace_id, collection_id, source)
       VALUES (7, '2026-10-05T12:00:00Z', 'user_ana', 'workspace_acme', 'collection_notes', 'api')`,
    );
  });

  it("gives each past brief what the collections its asker could read held when its day began, code left out", async () => {
    await db.exec(schemaSql);
    // On 5 October, notes held decision 1 (100), the Slack copy (1,000), the
    // Notion page (50) and the Drive file (5); docs 7; gone 9, not gone yet.
    expect(await searched()).toEqual({
      1: 100 + 1000 + 50 + 5 + 7 + 9,
      2: 100 + 1000 + 50 + 5 + 7 + 9,
      // A grant on notes, and docs is public.
      3: 100 + 1000 + 50 + 5 + 7,
      // Only what is public.
      4: 7,
      5: 11,
      // Notes grew by decision 2 and the newer message; late came, gone went.
      6: 120 + 1200 + 50 + 5 + 7 + 3,
      7: null,
    });
  });

  it("counts every day again on the rollup's next run, and only once", async () => {
    await db.exec(schemaSql);
    const days = await db.query("SELECT * FROM activity_days");
    const rollup = await db.query("SELECT * FROM activity_rollup");
    expect(days.rows).toEqual([]);
    expect(rollup.rows).toEqual([]);

    await db.exec(`
      INSERT INTO activity_rollup (through) VALUES ('2026-10-27');
      UPDATE query_events SET metadata = metadata || '{"searched_tokens": 1}' WHERE id = 1;
    `);
    await db.exec(schemaSql);
    expect((await db.query("SELECT * FROM activity_rollup")).rows).toHaveLength(1);
    expect((await searched())[1]).toBe(1);
  });

  it("fills collection_tokens, so briefs right after the deploy have their sizes", async () => {
    await db.exec(schemaSql);
    expect((await sizes())["collection_notes slack"]).toBe(1200);
  });
});
