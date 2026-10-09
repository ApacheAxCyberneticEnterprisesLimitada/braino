// Alexander, 2026-10-09 (decision_01M4GFJ3A5R9ASCBA6CWKDKSH3): GitHub brings
// issues, not bugs. schema.sql, which re-applies after every change to it,
// turns every GitHub bugs Doco into a GitHub issues Doco: the setup's
// `<workspace>-github-bugs` handle becomes `<workspace>-github-issues` when
// that is free and fits, the template's old goal becomes the new one, and a
// connected Doco imports its repositories again, now bringing every issue.
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
    `INSERT INTO docos (id, handle, owner_id, workspace_id, data, goal)
     VALUES ($1, $2, 'workspace_acme', 'workspace_acme', $3, $4)`,
    [id, handle, JSON.stringify({ handle, ...data }), goal],
  );
}

async function docoOf(id: string) {
  const r = await db.query<{ handle: string; goal: string; data: Record<string, unknown> }>(
    "SELECT handle, goal, data FROM docos WHERE id = $1",
    [id],
  );
  return r.rows[0];
}

describe("a GitHub bugs Doco becomes a GitHub issues Doco", () => {
  beforeEach(async () => {
    db = await freshDb();
    await db.exec(
      "INSERT INTO workspaces (id, handle, name) VALUES ('workspace_acme', 'acme', 'Acme')",
    );
  });

  it("renames the setup's handle, takes the new template and goal, and imports again", async () => {
    await seed("doco_bugs", "acme-github-bugs", {
      template_handle: "github-bugs",
      github_integration: { connections: CONNECTIONS, backfill: DONE },
    });
    await db.exec(schemaSql);
    const doco = await docoOf("doco_bugs");
    expect(doco.handle).toBe("acme-github-issues");
    expect(doco.goal).toBe(NEW_GOAL);
    expect(doco.data).toMatchObject({
      handle: "acme-github-issues",
      template_handle: "github-issues",
      github_integration: { connections: CONNECTIONS, backfill: { status: "running" } },
    });
    const backfill = (doco.data.github_integration as { backfill: Record<string, unknown> })
      .backfill;
    expect(Object.keys(backfill).sort()).toEqual(["started_at", "status"]);
  });

  it("keeps a handle it can't rename, a goal someone wrote, and an unconnected Doco idle", async () => {
    await seed("doco_taken", "beta-github-bugs", { template_handle: "github-bugs" }, "Our issues");
    await seed("doco_other", "beta-github-issues", { template_handle: "generic" });
    await seed("doco_custom", "acme-defects", { template_handle: "github-bugs" });
    const long = `${"x".repeat(51)}-github-bugs`;
    await seed("doco_long", long, { template_handle: "github-bugs" });
    await db.exec(schemaSql);

    expect(await docoOf("doco_taken")).toMatchObject({
      handle: "beta-github-bugs",
      goal: "Our issues",
      data: { handle: "beta-github-bugs", template_handle: "github-issues" },
    });
    expect((await docoOf("doco_custom")).handle).toBe("acme-defects");
    expect((await docoOf("doco_long")).handle).toBe(long);
    for (const id of ["doco_taken", "doco_custom", "doco_long"]) {
      expect((await docoOf(id)).data.github_integration, id).toBeUndefined();
    }
  });

  it("changes nothing when applied again", async () => {
    await seed("doco_bugs", "acme-github-bugs", {
      template_handle: "github-bugs",
      github_integration: { connections: CONNECTIONS, backfill: DONE },
    });
    await db.exec(schemaSql);
    const once = await docoOf("doco_bugs");
    await db.exec(schemaSql);
    expect(await docoOf("doco_bugs")).toEqual(once);
  });
});
