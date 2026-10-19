// Alexander, 2026-10-09 (decision_01M4GFJ3A5R9ASCBA6CWKDKSH3): GitHub brings
// issues, not bugs. schema.sql, which re-applies after every change to it,
// turns every GitHub bugs collection into a GitHub issues collection: the setup's
// `<workspace>-github-bugs` handle becomes `<workspace>-github-issues` when
// that is free and fits, the template's old goal becomes the new one, and a
// connected collection imports its repositories again, now bringing every issue.
// Applying it again changes nothing.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

const OLD_GOAL =
  "Track a GitHub repository's bugs — issues labeled bug, or of the Bug issue type, sync automatically, and closed issues retire.";
const NEW_GOAL =
  "Track a GitHub repository's issues — every issue syncs automatically, and closed issues retire.";
const CONNECTIONS = [{ repo: "acme/app", installation_id: 9 }];
const DONE = { status: "done", repos: 1, imported: 3 };

let db: PGlite;

async function seed(
  id: string,
  handle: string,
  data: Record<string, unknown>,
  goal = OLD_GOAL,
): Promise<void> {
  await db.query(
    `INSERT INTO collections (id, handle, owner_id, workspace_id, data, goal)
     VALUES ($1, $2, 'workspace_acme', 'workspace_acme', $3, $4)`,
    [id, handle, JSON.stringify({ handle, ...data }), goal],
  );
}

async function collectionOf(id: string) {
  const r = await db.query<{ handle: string; goal: string; data: Record<string, unknown> }>(
    "SELECT handle, goal, data FROM collections WHERE id = $1",
    [id],
  );
  return r.rows[0];
}

describe("a GitHub bugs collection becomes a GitHub issues collection", () => {
  beforeEach(async () => {
    db = await freshDb();
    await db.exec(
      "INSERT INTO workspaces (id, handle, name) VALUES ('workspace_acme', 'acme', 'Acme')",
    );
  });

  it("renames the setup's handle, takes the new template and goal, and imports again", async () => {
    await seed("collection_bugs", "acme-github-bugs", {
      template_handle: "github-bugs",
      github_integration: { connections: CONNECTIONS, backfill: DONE },
    });
    await db.exec(schemaSql);
    const collection = await collectionOf("collection_bugs");
    expect(collection.handle).toBe("acme-github-issues");
    expect(collection.goal).toBe(NEW_GOAL);
    expect(collection.data).toMatchObject({
      handle: "acme-github-issues",
      template_handle: "github-issues",
      github_integration: { connections: CONNECTIONS, backfill: { status: "running" } },
    });
    const backfill = (collection.data.github_integration as { backfill: Record<string, unknown> })
      .backfill;
    expect(Object.keys(backfill).sort()).toEqual(["started_at", "status"]);
  });

  it("keeps a handle it can't rename, a goal someone wrote, and an unconnected collection idle", async () => {
    await seed(
      "collection_taken",
      "beta-github-bugs",
      { template_handle: "github-bugs" },
      "Our issues",
    );
    await seed("collection_other", "beta-github-issues", { template_handle: "generic" });
    await seed("collection_custom", "acme-defects", { template_handle: "github-bugs" });
    const long = `${"x".repeat(51)}-github-bugs`;
    await seed("collection_long", long, { template_handle: "github-bugs" });
    await db.exec(schemaSql);

    expect(await collectionOf("collection_taken")).toMatchObject({
      handle: "beta-github-bugs",
      goal: "Our issues",
      data: { handle: "beta-github-bugs", template_handle: "github-issues" },
    });
    expect((await collectionOf("collection_custom")).handle).toBe("acme-defects");
    expect((await collectionOf("collection_long")).handle).toBe(long);
    for (const id of ["collection_taken", "collection_custom", "collection_long"]) {
      expect((await collectionOf(id)).data.github_integration, id).toBeUndefined();
    }
  });

  it("changes nothing when applied again", async () => {
    await seed("collection_bugs", "acme-github-bugs", {
      template_handle: "github-bugs",
      github_integration: { connections: CONNECTIONS, backfill: DONE },
    });
    await db.exec(schemaSql);
    const once = await collectionOf("collection_bugs");
    await db.exec(schemaSql);
    expect(await collectionOf("collection_bugs")).toEqual(once);
  });
});
