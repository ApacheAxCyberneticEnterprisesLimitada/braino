// Alexander, 2026-10-30, "Spot agents committing without Doco": relabel the
// older pull requests of every workspace once. Applying schema.sql queues
// each collection that brings pull requests from GitHub, last imported before
// they carried labels, for the background re-import "Re-import all" starts;
// once that import ran, a later boot queues nothing. Alexander, 2026-11-02,
// "Find why no alert for Oki skipping Doco": once more when a brief or record
// of another workspace stopped counting as going through Doco, which ran
// under the code the deploy replaced, as the build applies schema.sql before
// its code serves; and again when each pull request came to carry who opened
// it, with the marker's cursor ahead, so the sweep starts the import ten
// minutes on; and when only its author's records came to count as logging it.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

let db: PGlite;

const CONNECTED = { connections: [{ repo: "acme/app", installation_id: 7 }] };
const done = (at: string) => ({ status: "done", cursor_at: at, finished_at: at, queue: [] });

async function collection(id: string, data: Record<string, unknown>, deleted = false) {
  await db.query(
    `INSERT INTO collections (id, handle, owner_id, workspace_id, data, deleted_at)
     VALUES ($1, $1, 'workspace_1', 'workspace_1', $2, $3)`,
    [id, JSON.stringify(data), deleted ? "2026-10-01T00:00:00Z" : null],
  );
}

async function backfills(): Promise<Record<string, unknown>> {
  const { rows } = await db.query<{ id: string; backfill: unknown }>(
    "SELECT id, data->'github_integration'->'backfill' AS backfill FROM collections ORDER BY id",
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.backfill]));
}

beforeEach(async () => {
  db = await freshDb();
  await db.exec(
    `INSERT INTO workspaces (id, handle, name) VALUES ('workspace_1', 'acme', 'Acme');`,
  );
  const before = done("2026-10-20T00:00:00Z");
  await collection("prs", {
    template_handle: "github-pull-requests",
    github_integration: { ...CONNECTED, backfill: before },
  });
  await collection("decisions_with_prs", {
    template_handle: "product-decisions",
    github_integration: CONNECTED,
  });
  await collection("issues", {
    template_handle: "github-issues",
    github_integration: { ...CONNECTED, backfill: before },
  });
  await collection("code", {
    template_handle: "codebase",
    github_integration: { ...CONNECTED, backfill: before },
  });
  await collection("disconnected", {
    template_handle: "github-pull-requests",
    github_integration: { connections: [], backfill: before },
  });
  await collection("importing", {
    template_handle: "github-pull-requests",
    github_integration: {
      ...CONNECTED,
      backfill: { status: "running", cursor_at: "2026-10-20T00:00:00Z" },
    },
  });
  // Relabeled at 16:47, before only the author's records counted.
  await collection("labeled_before", {
    template_handle: "github-pull-requests",
    github_integration: { ...CONNECTED, backfill: done("2026-11-02T16:47:43Z") },
  });
  await collection("labeled", {
    template_handle: "github-pull-requests",
    github_integration: { ...CONNECTED, backfill: done("2026-11-02T22:30:00Z") },
  });
  await collection(
    "deleted",
    {
      template_handle: "github-pull-requests",
      github_integration: { ...CONNECTED, backfill: before },
    },
    true,
  );
});

describe("relabeling the pull requests imported before labels", () => {
  it("queues each connected collection that brings pull requests, last imported before labels", async () => {
    const was = await backfills();
    await db.exec(schemaSql);
    const now = await backfills();
    const queued = { status: "running", cursor_at: expect.any(String) };
    expect(now.prs).toEqual(queued);
    expect(now.decisions_with_prs).toEqual(queued);
    expect(now.labeled_before).toEqual(queued);
    for (const id of ["issues", "code", "disconnected", "importing", "labeled", "deleted"]) {
      expect(now[id]).toEqual(was[id]);
    }
  });

  it("starts the import ten minutes on, once the deploy's code serves", async () => {
    await db.exec(schemaSql);
    const { cursor_at } = (await backfills()).prs as { cursor_at: string };
    // The sweep takes up an import whose cursor sat still five minutes.
    expect(Date.parse(cursor_at) - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(Date.parse(cursor_at) - Date.now()).toBeLessThanOrEqual(5 * 60_000);
  });

  it("queues nothing on a later boot, once the import ran", async () => {
    await db.exec(schemaSql);
    await db.exec(`
      UPDATE collections
         SET data = jsonb_set(data, '{github_integration,backfill}',
                              '{"status": "done", "cursor_at": "2026-11-02T22:30:00Z"}'::jsonb)
       WHERE id IN ('prs', 'decisions_with_prs', 'labeled_before');
    `);
    const was = await backfills();
    await db.exec(schemaSql);
    expect(await backfills()).toEqual(was);
  });
});
