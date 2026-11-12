// What the alert about an agent's Braino setup keeps (Alexander, 2026-11-12,
// "Make agents aware of outdated instructions"): hook_copies, the copies of
// the Braino hook's script that named themselves to Braino, and
// silence_alerts.setup, what is wrong with the setup of the agent an alert is
// about. An agent may have gone quiet and have an outdated setup at once, so
// it may have one alert of each.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";

let db: PGlite;

const migration = () =>
  readFile(join(import.meta.dirname, "..", "..", "migrations", "011_hook_copies.sql"), "utf8");

const copy =
  "INSERT INTO hook_copies (workspace_id, user_id, agent, project, old_since) VALUES ('workspace_acme', 'user_ana', $1, $2, $3)";

/** An alert about Ana's agent in acme: a silence, or about its setup. */
const alert = (id: string, agent: string, setup: string | null) =>
  db.query(
    `INSERT INTO silence_alerts (id, workspace_id, user_id, agent, collection_ids, quiet_since, usual, setup)
     VALUES ($1, 'workspace_acme', 'user_ana', $2, '{}', now(), 0, $3)`,
    [id, agent, setup],
  );

beforeEach(async () => {
  db = await freshDb();
  await db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('workspace_acme', 'acme', 'Acme');
    INSERT INTO users (id, username, data) VALUES ('user_ana', 'ana', '{}');
    INSERT INTO collections (id, handle, owner_id, workspace_id, data)
      VALUES ('collection_notes', 'acme-notes', 'workspace_acme', 'workspace_acme', '{}');
  `);
});

describe("the copies of the Braino hook's script Braino heard from", () => {
  it("keeps one per workspace, person, agent and project, current until found old", async () => {
    await db.query(copy, ["Braino hook", "app", null]);
    await db.query(copy, ["Braino hook", "site", "2026-11-01T00:00:00Z"]);
    await db.query(copy, ["Codex Cloud · acme", "app", null]);
    await expect(db.query(copy, ["Braino hook", "app", null])).rejects.toThrow();

    const copies = await db.query<{ agent: string; project: string; old: boolean; seen: boolean }>(
      `SELECT agent, project, old_since IS NOT NULL AS old, seen_at IS NOT NULL AS seen
         FROM hook_copies ORDER BY agent, project`,
    );
    expect(copies.rows).toEqual([
      { agent: "Braino hook", project: "app", old: false, seen: true },
      { agent: "Braino hook", project: "site", old: true, seen: true },
      { agent: "Codex Cloud · acme", project: "app", old: false, seen: true },
    ]);
  });

  it("goes with its person and with its workspace", async () => {
    await db.query(copy, ["Braino hook", "app", null]);
    await db.exec("DELETE FROM users WHERE id = 'user_ana'");
    expect((await db.query("SELECT 1 FROM hook_copies")).rows).toEqual([]);

    await db.exec("INSERT INTO users (id, username, data) VALUES ('user_ana', 'ana', '{}')");
    await db.query(copy, ["Braino hook", "app", null]);
    await db.exec("DELETE FROM workspaces WHERE id = 'workspace_acme'");
    expect((await db.query("SELECT 1 FROM hook_copies")).rows).toEqual([]);
  });
});

describe("an alert about an agent's setup", () => {
  it("stands beside the agent's silence alert, one of each kind", async () => {
    await alert("alert_quiet", "Codex Cloud · acme", null);
    await alert("alert_missing", "Codex Cloud · acme", "missing");
    await alert("alert_old", "Codex Cloud · acme", "old");

    await expect(alert("alert_quiet_2", "Codex Cloud · acme", null)).rejects.toThrow();
    await expect(alert("alert_old_2", "Codex Cloud · acme", "old")).rejects.toThrow();
  });

  it("says an old copy or none heard from, and only of an agent", async () => {
    await expect(alert("alert_odd", "Codex Cloud · acme", "stale")).rejects.toThrow();
    await expect(
      db.query(
        `INSERT INTO silence_alerts (id, workspace_id, collection_id, collection_ids, quiet_since, usual, setup)
         VALUES ('alert_collection', 'workspace_acme', 'collection_notes', '{collection_notes}', now(), 9, 'old')`,
      ),
    ).rejects.toThrow();
  });
});

describe("a database from before the alerts about setups", () => {
  beforeEach(async () => {
    await db.exec(`
      DROP TABLE hook_copies;
      ALTER TABLE silence_alerts DROP COLUMN setup CASCADE;
      CREATE UNIQUE INDEX silence_alerts_agent_idx
        ON silence_alerts (workspace_id, user_id, agent) WHERE agent IS NOT NULL;
      INSERT INTO silence_alerts (id, workspace_id, user_id, agent, collection_ids, quiet_since, usual, email_step)
        VALUES ('alert_quiet', 'workspace_acme', 'user_ana', 'Codex Cloud · acme', '{}', now(), 0, 2);
    `);
  });

  it("gains both, its open alerts staying silence alerts with their emails counted", async () => {
    await db.exec(await migration());

    await db.query(copy, ["Braino hook", "app", null]);
    await alert("alert_missing", "Codex Cloud · acme", "missing");
    await expect(alert("alert_quiet_2", "Codex Cloud · acme", null)).rejects.toThrow();
    const alerts = await db.query<{ id: string; setup: string | null; email_step: number }>(
      "SELECT id, setup, email_step FROM silence_alerts ORDER BY id",
    );
    expect(alerts.rows).toEqual([
      { id: "alert_missing", setup: "missing", email_step: 0 },
      { id: "alert_quiet", setup: null, email_step: 2 },
    ]);
  });

  it("keeps one key for an agent's alerts, and the same on a second run", async () => {
    await db.exec(await migration());
    await db.exec(await migration());

    const indexes = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'silence_alerts' AND indexname LIKE 'silence_alerts_agent%'`,
    );
    expect(indexes.rows).toEqual([{ indexname: "silence_alerts_agent_setup_idx" }]);
  });
});
