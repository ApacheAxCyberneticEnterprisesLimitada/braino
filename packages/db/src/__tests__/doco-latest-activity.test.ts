// Each Doco keeps when it last saw activity on its own row
// (docos.latest_activity_at), so the Workspaces page and each workspace's Doco
// list read it with the Docos they load instead of probing every source on
// every view (decision_01M4GZ5ZJ30TM35CV77ZYREAA9). Activity is a change to
// the Doco's content (an audit event; policies are settings) or an item an
// integration brought (the imported_items view). Triggers on each source move
// the time forward; the boot that adds the column fills it once.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

let db: PGlite;

async function latest(): Promise<Record<string, string | null>> {
  const r = await db.query<{ id: string; at: Date | null }>(
    "SELECT id, latest_activity_at AS at FROM docos ORDER BY id",
  );
  return Object.fromEntries(r.rows.map((row) => [row.id, row.at?.toISOString() ?? null]));
}

async function latestOf(id: string): Promise<string | null> {
  return (await latest())[id] ?? null;
}

beforeEach(async () => {
  db = await freshDb();
  await db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('workspace_acme', 'acme', 'Acme');
    INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES
      ('doco_notes', 'acme-notes', 'workspace_acme', 'workspace_acme', '{}'),
      ('doco_bugs', 'acme-bugs', 'workspace_acme', 'workspace_acme', '{}'),
      ('doco_quiet', 'acme-quiet', 'workspace_acme', 'workspace_acme', '{}');
    INSERT INTO group_chat_installations (id, provider, workspace_id, workspace_name, doco_workspace_id)
      VALUES ('gci_1', 'slack', 'T1', 'Acme', 'workspace_acme');
    INSERT INTO group_chat_mirrors (doco_id, installation_id, team_domain, history_since, consented_at)
      VALUES ('doco_notes', 'gci_1', 'acme', '2020-01-01T00:00:00Z', now());
    INSERT INTO group_chat_channels (doco_id, channel_id, name, joined_at, excluded, archived) VALUES
      ('doco_notes', 'C_GEN', 'general', now(), false, false),
      ('doco_notes', 'C_HID', 'hidden', now(), true, false);
    INSERT INTO notion_mirrors (doco_id, workspace_id, workspace_name, bot_id, access_token, consented_at)
      VALUES ('doco_notes', 'ws-1', 'Acme', 'bot-1', 'v1:enc', now());
  `);
});

describe("a Doco's latest activity", () => {
  it("starts empty", async () => {
    expect(await latest()).toEqual({ doco_bugs: null, doco_notes: null, doco_quiet: null });
  });

  it("moves with each change to the Doco's content, but not with a policy edit", async () => {
    await db.exec(`
      INSERT INTO audit_events (event_id, at, doco_id, entity_type, entity_id, op)
        VALUES ('ev_1', '2026-09-10T00:00:00Z', 'doco_bugs', 'eval', 'eval_1', 'entity.create')`);
    expect(await latestOf("doco_bugs")).toBe("2026-09-10T00:00:00.000Z");

    await db.exec(`
      INSERT INTO audit_events (event_id, at, doco_id, entity_type, entity_id, op)
        VALUES ('ev_2', '2026-09-20T00:00:00Z', 'doco_bugs', 'policy', 'policy_1', 'entity.update')`);
    expect(await latestOf("doco_bugs")).toBe("2026-09-10T00:00:00.000Z");
  });

  it("moves with each item an integration brings", async () => {
    await db.exec(`
      INSERT INTO code_files (doco_id, repo, path, sha, size, synced_at)
        VALUES ('doco_notes', 'acme/app', 'a.ts', 's1', 1, '2026-09-02T08:00:00Z')`);
    expect(await latestOf("doco_notes")).toBe("2026-09-02T08:00:00.000Z");

    await db.exec(`
      INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, locator, updated_at)
        VALUES ('reference_1', 'doco_notes', 'reference', 'active', 'Add login',
                'https://github.com/acme/app/pull/7', '2026-09-03T08:00:00Z')`);
    expect(await latestOf("doco_notes")).toBe("2026-09-03T08:00:00.000Z");

    await db.exec(`
      INSERT INTO group_chat_messages (doco_id, channel_id, ts, text, posted_at)
        VALUES ('doco_notes', 'C_GEN', '1.1', 'hello', '2026-09-03T09:00:00Z')`);
    expect(await latestOf("doco_notes")).toBe("2026-09-03T09:00:00.000Z");

    await db.exec(`
      INSERT INTO notion_pages (doco_id, page_id, object, url, last_edited_time, synced_at)
        VALUES ('doco_notes', 'p1', 'page', 'https://www.notion.so/p1', '2026-09-04T09:00:00Z', now())`);
    expect(await latestOf("doco_notes")).toBe("2026-09-04T09:00:00.000Z");

    // A resync and an updated pull request are activity too.
    await db.exec(`UPDATE code_files SET synced_at = '2026-09-05T00:00:00Z' WHERE path = 'a.ts'`);
    expect(await latestOf("doco_notes")).toBe("2026-09-05T00:00:00.000Z");
    await db.exec(`UPDATE nodes SET updated_at = '2026-09-06T00:00:00Z' WHERE id = 'reference_1'`);
    expect(await latestOf("doco_notes")).toBe("2026-09-06T00:00:00.000Z");

    expect(await latestOf("doco_quiet")).toBeNull();
  });

  it("leaves out what the Doco doesn't show, until it does", async () => {
    await db.exec(`
      INSERT INTO group_chat_messages (doco_id, channel_id, ts, text, posted_at)
        VALUES ('doco_notes', 'C_HID', '1.2', 'left out', '2026-09-05T09:00:00Z');
      INSERT INTO notion_pages (doco_id, page_id, object, url, last_edited_time, synced_at)
        VALUES ('doco_notes', 'p3', 'page', 'https://www.notion.so/p3', '2026-09-06T09:00:00Z', NULL);
      INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, updated_at)
        VALUES ('decision_1', 'doco_notes', 'decision', 'active', 'Not from GitHub', '2026-09-07T00:00:00Z');
    `);
    expect(await latestOf("doco_notes")).toBeNull();

    // Fetching the Notion page makes it part of the Doco.
    await db.exec(`UPDATE notion_pages SET synced_at = now() WHERE page_id = 'p3'`);
    expect(await latestOf("doco_notes")).toBe("2026-09-06T09:00:00.000Z");
  });

  it("never moves back when older history arrives", async () => {
    await db.exec(`
      INSERT INTO group_chat_messages (doco_id, channel_id, ts, text, posted_at)
        VALUES ('doco_notes', 'C_GEN', '2.1', 'today', '2026-09-20T00:00:00Z')`);
    await db.exec(`
      INSERT INTO group_chat_messages (doco_id, channel_id, ts, text, posted_at) VALUES
        ('doco_notes', 'C_GEN', '0.1', 'last year', '2025-09-20T00:00:00Z'),
        ('doco_notes', 'C_GEN', '0.2', 'last month', '2026-08-20T00:00:00Z')`);
    expect(await latestOf("doco_notes")).toBe("2026-09-20T00:00:00.000Z");
  });

  it("is filled once, from the whole history, on the boot that adds it", async () => {
    await db.exec(`
      INSERT INTO audit_events (event_id, at, doco_id, entity_type, entity_id, op) VALUES
        ('ev_1', '2026-09-10T00:00:00Z', 'doco_bugs', 'eval', 'eval_1', 'entity.create'),
        ('ev_2', '2026-09-20T00:00:00Z', 'doco_bugs', 'policy', 'policy_1', 'entity.update');
      INSERT INTO group_chat_messages (doco_id, channel_id, ts, text, posted_at) VALUES
        ('doco_notes', 'C_GEN', '1.1', 'hello', '2026-09-03T09:00:00Z'),
        ('doco_notes', 'C_HID', '1.2', 'left out', '2026-09-05T09:00:00Z');
      -- A database from before the column, and the triggers that keep it.
      DROP FUNCTION catch_up_docos_activity() CASCADE;
      ALTER TABLE docos DROP COLUMN latest_activity_at;
    `);
    await db.exec(schemaSql);
    expect(await latest()).toEqual({
      doco_bugs: "2026-09-10T00:00:00.000Z",
      doco_notes: "2026-09-03T09:00:00.000Z",
      doco_quiet: null,
    });
  });
});
