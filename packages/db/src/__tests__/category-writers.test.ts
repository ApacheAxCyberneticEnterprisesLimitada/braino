import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { nodeRowFromFields, rowToNode, upsertNode, upsertPolicy } from "../repo.js";
import { freshDb } from "./fresh-db.js";

// Write path #2(B): the generic `EntityRecord` god-type + `upsertEntity`
// dispatcher are gone. Each category has ONE honest writer:
//   - nodes   → `upsertNode(nodeRowFromFields(type, fields))` — no `data` bag
//   - policies → `upsertPolicy(PolicyWrite)` — keeps its real `policies.data` jsonb
// These pin that both land their rows correctly through a real Postgres.

const DOCO = "doco_cw00000000000000000000000000";
const ORG = "workspace_cw0000000000000000000";

let db: PGlite;

beforeAll(async () => {
  db = await freshDb();
  await db.query("INSERT INTO workspaces (id, handle, name) VALUES ($1,$2,$3)", [
    ORG,
    "ws-cw",
    "WS CW",
  ]);
  await db.query(
    "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ($1,$2,$3,$4,'{}'::jsonb)",
    [DOCO, "doco-cw", ORG, ORG],
  );
});

describe("per-category writers (no EntityRecord god-type)", () => {
  it("upsertNode persists a node from the honest NodeRow boundary", async () => {
    const id = "reference_cw0000000000000000000000";
    await upsertNode(
      nodeRowFromFields("reference", {
        id,
        doco_id: DOCO,
        node_type: "reference",
        prose: "ACME PR #1",
        locator: "https://example.com/pr/1", // promoted column
        pr_body: "the body", // domain field → extra
        lifecycle: "active",
      }),
      db as never,
    );
    const r = await db.query<Record<string, unknown>>("SELECT * FROM nodes WHERE id = $1", [id]);
    const node = rowToNode(r.rows[0]);
    expect(node).toMatchObject({
      id,
      node_type: "reference",
      prose: "ACME PR #1",
      locator: "https://example.com/pr/1",
      lifecycle: "active",
    });
    expect(node.extra).toEqual({ pr_body: "the body" });
  });

  it("upsertPolicy persists a policy, mirroring kind to its column and keeping data", async () => {
    const id = "policy_cw00000000000000000000000000";
    const data = {
      id,
      doco_id: DOCO,
      kind: "deterministic",
      predicate: { sub_kind: "requires_edge", edge_type: "supports" },
      on_violation: "block",
      lifecycle: "active",
    };
    await upsertPolicy(
      { id, doco_id: DOCO, lifecycle: "active", data, updated_by: "user_cw" },
      db as never,
    );
    const r = await db.query<{
      id: string;
      lifecycle: string;
      kind: string;
      data: Record<string, unknown>;
    }>("SELECT id, lifecycle, kind, data FROM policies WHERE id = $1", [id]);
    expect(r.rows[0]).toMatchObject({ id, lifecycle: "active", kind: "deterministic" });
    // The structured fields survive in the kept `policies.data` jsonb.
    expect(r.rows[0].data).toMatchObject({
      predicate: { sub_kind: "requires_edge", edge_type: "supports" },
      on_violation: "block",
    });
  });
});
