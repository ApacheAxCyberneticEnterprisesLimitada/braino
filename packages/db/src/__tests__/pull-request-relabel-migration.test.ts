// Alexander, 2026-10-30, "Spot agents committing without Doco": relabel the
// older pull requests of every workspace once. Applying schema.sql queues
// each collection that brings pull requests from GitHub, last imported before
// they carried labels, for the background re-import "Re-import all" starts;
// once that import ran, a later boot queues nothing.
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
  await collection("labeled", {
    template_handle: "github-pull-requests",
    github_integration: { ...CONNECTED, backfill: done("2026-10-30T02:00:00Z") },
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
    expect(now.prs).toEqual({ status: "running" });
    expect(now.decisions_with_prs).toEqual({ status: "running" });
    for (const id of ["issues", "code", "disconnected", "importing", "labeled", "deleted"]) {
      expect(now[id]).toEqual(was[id]);
    }
  });

  it("queues nothing on a later boot, once the import ran", async () => {
    await db.exec(schemaSql);
    await db.exec(`
      UPDATE collections
         SET data = jsonb_set(data, '{github_integration,backfill}',
                              '{"status": "done", "cursor_at": "2026-10-30T03:00:00Z"}'::jsonb)
       WHERE id IN ('prs', 'decisions_with_prs');
    `);
    const was = await backfills();
    await db.exec(schemaSql);
    expect(await backfills()).toEqual(was);
  });
});
