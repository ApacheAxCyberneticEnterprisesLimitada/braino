import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { type NodeRow, nodeRowFromFields, rowToNode, upsertNode } from "../repo.js";
import { freshDb } from "./fresh-db.js";

// `NODE_PROMOTED_COLUMNS` is the one source of truth for which scalars get their
// own typed column. `rowToNode` reads those columns straight off the row — these
// round-trips guard that every genuinely promoted column survives a write→read
// cycle, and the long-dead `role_principal` (no column, never persisted) never
// reappears.

const DOCO = "doco_promoted0000000000000000000";
const ORG = "workspace_promoted00000000000";

let db: PGlite;

async function readBack(id: string): Promise<NodeRow> {
  const r = await db.query<Record<string, unknown>>("SELECT * FROM nodes WHERE id = $1", [id]);
  return rowToNode(r.rows[0] as Record<string, unknown>);
}

beforeAll(async () => {
  db = await freshDb();
  await db.query("INSERT INTO workspaces (id, handle, name) VALUES ($1, $2, $3)", [
    ORG,
    "workspace-promoted",
    "Workspace Promoted",
  ]);
  await db.query(
    "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ($1,$2,$3,$4,'{}'::jsonb)",
    [DOCO, "doco-promoted", ORG, ORG],
  );
  await db.query("INSERT INTO users (id, github_login, data) VALUES ($1,$2,'{}'::jsonb)", [
    "user_promoted0000000000000000000",
    "promoted-user",
  ]);
});

describe("promoted columns — single source of truth round-trips", () => {
  it("surfaces every genuinely promoted column on read", async () => {
    const cases: {
      type: string;
      id: string;
      data: Record<string, unknown>;
      expect: [string, unknown];
    }[] = [
      {
        type: "eval",
        id: "eval_promoted00000000000000000000",
        data: { eval: "check it", kind: "unit" },
        expect: ["kind", "unit"],
      },
      {
        type: "state",
        id: "state_promoted0000000000000000000",
        data: { state: "ready", kind: "initial" },
        expect: ["kind", "initial"],
      },
      {
        type: "idea",
        id: "idea_promoted00000000000000000000",
        data: { idea: "an idea", proposer_id: "user_promoted0000000000000000000" },
        expect: ["proposer_id", "user_promoted0000000000000000000"],
      },
      {
        type: "reference",
        id: "reference_promoted000000000000000",
        data: { reference: "a doc", locator: "https://example.com/doc" },
        expect: ["locator", "https://example.com/doc"],
      },
      {
        // A bug imported from GitHub keeps the issue it came from.
        type: "eval",
        id: "eval_promotedlocator0000000000000",
        data: { eval: "login fails", locator: "https://github.com/acme/app/issues/7" },
        expect: ["locator", "https://github.com/acme/app/issues/7"],
      },
    ];

    for (const c of cases) {
      await upsertNode(
        nodeRowFromFields(c.type, {
          id: c.id,
          doco_id: DOCO,
          node_type: c.type,
          lifecycle: "active",
          ...c.data,
        }),
        db as never,
      );
      const rec = await readBack(c.id);
      const [field, value] = c.expect;
      expect((rec as unknown as Record<string, unknown>)[field]).toBe(value);
    }
  });

  it("never re-surfaces the dead role_principal (no column, scrubbed on write)", async () => {
    const id = "principal_promoted000000000000000";
    // A client may still send the legacy `role_principal`; it must persist
    // nowhere (no column, excluded from `extra`) and never read back.
    await upsertNode(
      nodeRowFromFields("principal", {
        id,
        doco_id: DOCO,
        node_type: "principal",
        prose: "Reviewer",
        kind: "agent",
        role_principal: true,
        lifecycle: "active",
      }),
      db as never,
    );
    const rec = await readBack(id);
    expect(rec.kind).toBe("agent");
    expect(rec.prose).toBe("Reviewer");
    expect(rec.extra).not.toHaveProperty("role_principal");
  });
});
