import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

describe("Braino Times migration", () => {
  it("preserves one latest historical edition per local day", async () => {
    await db.exec(`
      ALTER TABLE times_editions DROP CONSTRAINT times_editions_pkey;
      ALTER TABLE times_editions DROP COLUMN edition_day;
      ALTER TABLE workspaces DROP COLUMN times_timezone;
    `);
    await db.query(
      `INSERT INTO workspaces (id, handle, name) VALUES ('workspace_times', 'times', 'Times')`,
    );
    await db.query(
      `INSERT INTO times_editions (workspace_id, cadence, published_at, stories) VALUES
       ('workspace_times', 'daily', '2026-11-12T08:00:00.000Z', '[{"id":"older"}]'),
       ('workspace_times', 'daily', '2026-11-12T08:05:00.000Z', '[{"id":"latest"}]')`,
    );
    const migration = await readFile(
      join(import.meta.dirname, "..", "..", "migrations", "007_braino_times.sql"),
      "utf8",
    );

    await db.exec(migration);

    const workspace = await db.query<{ times_timezone: string }>(
      "SELECT times_timezone FROM workspaces WHERE id = 'workspace_times'",
    );
    expect(workspace.rows[0]?.times_timezone).toBe("America/Los_Angeles");
    const editions = await db.query<{
      edition_day: Date | string;
      stories: Array<{ id: string }>;
    }>(
      `SELECT edition_day, stories FROM times_editions
        WHERE workspace_id = 'workspace_times'`,
    );
    expect(
      editions.rows.map((edition) => ({
        ...edition,
        edition_day: new Date(edition.edition_day).toISOString().slice(0, 10),
      })),
    ).toEqual([{ edition_day: "2026-11-12", stories: [{ id: "latest" }] }]);
  });
});
