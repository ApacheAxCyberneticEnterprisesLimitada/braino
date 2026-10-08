// Alexander, 2026-09-30: every integration fills a standalone Doco of its own,
// so bugs from GitHub moved out of the workspace's Bug tracker into a GitHub
// bugs Doco. A Bug tracker the GitHub setup had already connected would
// otherwise fall back to bringing pull requests, so schema.sql, which
// re-applies after every change to it, drops the GitHub connection of every
// Bug tracker. Every other Doco keeps its connection, and applying it again
// changes nothing.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

const GITHUB = {
  connections: [{ repo: "acme/app", installation_id: 9 }],
  installations: [{ installation_id: 9, account: "acme" }],
};

let db: PGlite;

async function seed(id: string, data: Record<string, unknown>): Promise<void> {
  await db.query(
    `INSERT INTO docos (id, handle, owner_id, workspace_id, data)
     VALUES ($1, $1, 'workspace_acme', 'workspace_acme', $2)`,
    [id, JSON.stringify(data)],
  );
}

async function dataOf(id: string): Promise<Record<string, unknown>> {
  const r = await db.query<{ data: Record<string, unknown> }>(
    "SELECT data FROM docos WHERE id = $1",
    [id],
  );
  return r.rows[0]?.data ?? {};
}

describe("a Bug tracker no longer brings anything from GitHub", () => {
  beforeEach(async () => {
    db = await freshDb();
    await db.exec(
      "INSERT INTO workspaces (id, handle, name) VALUES ('workspace_acme', 'acme', 'Acme')",
    );
  });

  it("drops a Bug tracker's GitHub connection and keeps the rest of its data", async () => {
    await seed("acme-bugs", { template_handle: "bugs", github_integration: GITHUB, pinned: true });
    await db.exec(schemaSql);
    expect(await dataOf("acme-bugs")).toEqual({ template_handle: "bugs", pinned: true });
  });

  it("leaves every other Doco's GitHub connection alone", async () => {
    await seed("acme-github-bugs", { template_handle: "github-bugs", github_integration: GITHUB });
    await seed("acme-pull-requests", {
      template_handle: "github-pull-requests",
      github_integration: GITHUB,
    });
    await seed("acme-legacy", { github_integration: GITHUB });
    await db.exec(schemaSql);
    for (const id of ["acme-github-bugs", "acme-pull-requests", "acme-legacy"]) {
      expect((await dataOf(id)).github_integration, id).toEqual(GITHUB);
    }
  });
});
