// A Log or an Action used to be saved retired, meaning it was done; everywhere
// else retired means replaced or withdrawn, so feeds struck every chat Log
// through, and the graph, search and briefs hid them (Alexander, 2026-10-24:
// "Why are the logs added all retired?"). Now they are saved active, and
// schema.sql makes active the ones saved before that nothing replaced and
// nobody retired.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

let db: PGlite;

async function lifecycles(): Promise<Record<string, string>> {
  const r = await db.query<{ id: string; lifecycle: string }>(
    "SELECT id, lifecycle FROM nodes ORDER BY id",
  );
  return Object.fromEntries(r.rows.map((row) => [row.id, row.lifecycle]));
}

describe("Logs and Actions saved retired", () => {
  beforeEach(async () => {
    db = await freshDb();
    await db.exec(`
      INSERT INTO workspaces (id, handle, name) VALUES ('workspace_acme', 'acme', 'Acme');
      INSERT INTO collections (id, handle, owner_id, workspace_id, data) VALUES
        ('collection_chats', 'acme-chats', 'workspace_acme', 'workspace_acme', '{}');
      INSERT INTO nodes (id, collection_id, node_type, lifecycle, prose, created_at) VALUES
        ('log_done', 'collection_chats', 'log', 'retired', 'Ana asked; PR #42.', '2026-10-23T10:00:00Z'),
        ('log_old', 'collection_chats', 'log', 'retired', 'Ana asked.', '2026-10-23T09:00:00Z'),
        ('log_new', 'collection_chats', 'log', 'retired', 'Ana asked; it shipped.', '2026-10-23T11:00:00Z'),
        ('log_dropped', 'collection_chats', 'log', 'retired', 'A wrong log.', '2026-10-23T12:00:00Z'),
        ('action_done', 'collection_chats', 'action', 'retired', 'Deployed.', '2026-10-23T13:00:00Z'),
        ('decision_old', 'collection_chats', 'decision', 'retired', 'An old call.', '2026-10-23T14:00:00Z'),
        ('log_later', 'collection_chats', 'log', 'retired', 'Saved retired on purpose.', '2026-10-28T09:00:00Z');
      -- log_new replaced log_old.
      INSERT INTO edges (id, collection_id, from_id, from_node_type, to_id, to_node_type, edge_type)
        VALUES ('edge_r', 'collection_chats', 'log_new', 'log', 'log_old', 'log', 'replaces');
      -- Someone retired log_dropped.
      INSERT INTO audit_events (event_id, at, collection_id, entity_type, entity_id, op, before_json, after_json)
        VALUES ('ev_drop', '2026-10-23T12:05:00Z', 'collection_chats', 'log', 'log_dropped',
                'lifecycle.transition', '{"lifecycle": "active"}', '{"lifecycle": "retired"}');
      UPDATE nodes SET lifecycle = 'retired' WHERE id = 'log_new';
    `);
  });

  it("makes active those nothing replaced and nobody retired", async () => {
    const before = new Map(
      (
        await db.query<{ id: string; updated_at: Date }>("SELECT id, updated_at FROM nodes")
      ).rows.map((r) => [r.id, r.updated_at.toISOString()]),
    );
    await db.exec(schemaSql);
    expect(await lifecycles()).toEqual({
      action_done: "active",
      decision_old: "retired",
      log_done: "active",
      log_dropped: "retired",
      log_later: "retired",
      log_new: "active",
      log_old: "retired",
    });
    // Nothing about them changed but the word for their state, so they don't
    // come back as this week's news.
    const { rows } = await db.query<{ updated_at: Date }>(
      "SELECT updated_at FROM nodes WHERE id = 'log_done'",
    );
    expect(rows[0]?.updated_at.toISOString()).toBe(before.get("log_done"));
  });
});
