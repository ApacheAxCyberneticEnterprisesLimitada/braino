// Touches follow their node: schema.sql's trigger fills `node_touches` with
// the file paths, URLs, node ids and pull request numbers a node's prose and
// locator name, replaces them when the text changes, and the rows go with the
// node. The brief looks decisions up by these.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";

let db: PGlite;

async function touchesOf(nodeId: string): Promise<[string, string][]> {
  const r = await db.query<{ kind: string; value: string }>(
    "SELECT kind, value FROM node_touches WHERE node_id = $1 ORDER BY kind, value",
    [nodeId],
  );
  return r.rows.map((row) => [row.kind, row.value]);
}

beforeEach(async () => {
  db = await freshDb();
  await db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('ws', 'ws', 'WS');
    INSERT INTO docos (id, handle, owner_id, workspace_id, data)
      VALUES ('doco_1', 'd', 'ws', 'ws', '{}'::jsonb);
  `);
});

describe("node_touches", () => {
  it("extracts paths, URLs, node ids and pull request numbers from the prose", async () => {
    await db.query(
      `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose) VALUES ($1, 'doco_1', 'decision', 'active', $2)`,
      [
        "decision_01M3YXBFVNKEN703EAMWCW26QH",
        [
          "Edit packages/web/app/lib/search.server.ts and ./packages/db/src/schema.sql (PR #1331),",
          "see https://doco.to/meta-doco/decision/decision_01M3YV52H2CTFEGW0P0KAZ2DEP.",
          "Builds on idea_01M3YV52H2CTFEGW0P0KAZ2DEP and https://github.com/torrenegra/doco/pull/1330",
          "The file /home/user/doco/AGENTS.md is loaded via CLAUDE.md; version 1.2 is not a path.",
        ].join("\n"),
      ],
    );
    expect(await touchesOf("decision_01M3YXBFVNKEN703EAMWCW26QH")).toEqual([
      ["node", "decision_01M3YV52H2CTFEGW0P0KAZ2DEP"],
      ["node", "idea_01M3YV52H2CTFEGW0P0KAZ2DEP"],
      ["path", "home/user/doco/AGENTS.md"],
      ["path", "packages/db/src/schema.sql"],
      ["path", "packages/web/app/lib/search.server.ts"],
      ["pr", "#1330"],
      ["pr", "#1331"],
      ["url", "https://doco.to/meta-doco/decision/decision_01M3YV52H2CTFEGW0P0KAZ2DEP"],
      ["url", "https://github.com/torrenegra/doco/pull/1330"],
    ]);
  });

  it("takes the locator too, and replaces the rows when the text changes", async () => {
    await db.query(
      `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, locator)
       VALUES ('reference_1', 'doco_1', 'reference', 'active', 'Fix the login bug', 'https://github.com/o/r/pull/7')`,
    );
    expect(await touchesOf("reference_1")).toEqual([
      ["pr", "#7"],
      ["url", "https://github.com/o/r/pull/7"],
    ]);
    await db.query(
      "UPDATE nodes SET prose = 'Fix the login bug in app/login.ts' WHERE id = 'reference_1'",
    );
    expect(await touchesOf("reference_1")).toEqual([
      ["path", "app/login.ts"],
      ["pr", "#7"],
      ["url", "https://github.com/o/r/pull/7"],
    ]);
    await db.query(
      "UPDATE nodes SET prose = 'Nothing named here', locator = NULL WHERE id = 'reference_1'",
    );
    expect(await touchesOf("reference_1")).toEqual([]);
  });

  it("drops the rows with the node", async () => {
    await db.query(
      `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose)
       VALUES ('log_1', 'doco_1', 'log', 'active', 'Touched app/x.ts')`,
    );
    expect(await touchesOf("log_1")).toEqual([["path", "app/x.ts"]]);
    await db.query("DELETE FROM nodes WHERE id = 'log_1'");
    expect(await touchesOf("log_1")).toEqual([]);
  });
});
