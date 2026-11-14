import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";

// A chat keeps one Log. Each time an agent rewrote it, the rewrite saved a new
// Log and retired the one before, linked by a `replaces` edge. Those earlier
// drafts were retired by the rewrite, not withdrawn, so they come back active
// (Alexander, 2026-11-14: "Force an update to unretire them"). A Log retired
// on purpose, and anything else a newer node replaced, stays retired.
describe("unretire rewritten Logs migration", () => {
  it("makes active every Log another Log replaced, and nothing else", async () => {
    const db = await freshDb();
    await db.exec(`
      INSERT INTO workspaces (id, handle, name) VALUES ('workspace_acme', 'acme', 'Acme');
      INSERT INTO collections (id, handle, owner_id, workspace_id, data) VALUES
        ('collection_chats', 'acme-agents-chats', 'workspace_acme', 'workspace_acme', '{}'),
        ('collection_notes', 'acme-notes', 'workspace_acme', 'workspace_acme', '{}');
      INSERT INTO nodes (id, collection_id, node_type, lifecycle, prose, updated_at) VALUES
        ('log_draft1', 'collection_chats', 'log', 'retired', 'Ana asked Codex for every page.', '2026-11-09T10:00:00Z'),
        ('log_draft2', 'collection_chats', 'log', 'retired', 'Ana asked Codex; one page reached.', '2026-11-09T10:01:00Z'),
        ('log_latest', 'collection_chats', 'log', 'active', 'Ana asked Codex; it found blockers.', '2026-11-09T10:02:00Z'),
        ('log_withdrawn', 'collection_chats', 'log', 'retired', 'Logged in the wrong place.', '2026-11-09T11:00:00Z'),
        ('decision_old', 'collection_notes', 'decision', 'retired', 'Ship daily', '2026-11-09T12:00:00Z'),
        ('decision_new', 'collection_notes', 'decision', 'active', 'Ship weekly', '2026-11-09T12:01:00Z');
      INSERT INTO edges (id, collection_id, edge_type, from_id, from_node_type, to_id, to_node_type, lifecycle) VALUES
        ('edge_r1', 'collection_chats', 'replaces', 'log_draft2', 'log', 'log_draft1', 'log', 'drafting'),
        ('edge_r2', 'collection_chats', 'replaces', 'log_latest', 'log', 'log_draft2', 'log', 'drafting'),
        ('edge_r3', 'collection_notes', 'replaces', 'decision_new', 'decision', 'decision_old', 'decision', 'drafting');
    `);

    const migration = await readFile(
      join(import.meta.dirname, "..", "..", "migrations", "015_unretire_rewritten_logs.sql"),
      "utf8",
    );
    await db.exec(migration);

    const nodes = await db.query<{ id: string; lifecycle: string; updated_at: Date }>(
      "SELECT id, lifecycle, updated_at FROM nodes ORDER BY id",
    );
    expect(nodes.rows.map((n) => [n.id, n.lifecycle])).toEqual([
      ["decision_new", "active"],
      ["decision_old", "retired"],
      ["log_draft1", "active"],
      ["log_draft2", "active"],
      ["log_latest", "active"],
      ["log_withdrawn", "retired"],
    ]);
    // Only their state changes: a fresh updated_at would put every old draft
    // in this week's briefs.
    expect(
      nodes.rows
        .filter((n) => n.id.startsWith("log_draft"))
        .map((n) => new Date(n.updated_at).toISOString()),
    ).toEqual(["2026-11-09T10:00:00.000Z", "2026-11-09T10:01:00.000Z"]);
  });
});
