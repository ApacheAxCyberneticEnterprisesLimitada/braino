// Alexander, 2026-11-12 ("Stop alerts for PRs already seen via GitHub"):
// remove the alerts about pull requests a workspace couldn't see, and every
// trace of them. The table that kept who was told and disregarded goes too.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";

describe("unseen work retirement migration", () => {
  it("drops the table that kept the alerts' state", async () => {
    const db = await freshDb();
    await db.exec(`
      CREATE TABLE unseen_work_authors (
        workspace_id text NOT NULL,
        login text NOT NULL,
        PRIMARY KEY (workspace_id, login)
      );
      INSERT INTO unseen_work_authors (workspace_id, login) VALUES ('workspace_1', 'gus657');
    `);
    const migration = await readFile(
      join(import.meta.dirname, "..", "..", "migrations", "009_retire_unseen_work.sql"),
      "utf8",
    );

    await db.exec(migration);

    const result = await db.query<{ table_name: string | null }>(
      "SELECT to_regclass('public.unseen_work_authors')::text AS table_name",
    );
    expect(result.rows[0]?.table_name).toBeNull();
  });
});
