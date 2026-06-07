import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { freshDb } from "./fresh-db.js";

// Slice teardown (docs/simplification-plan.md): a Principal is an ordinary node
// (`node_type = 'principal'`), so `getPrincipalById` / `listPrincipals` read it
// through the ONE canonical node path (getEntity / listEntitiesByDoco →
// rowToEntity) — no bespoke `prose AS name` SQL + `mapPrincipalRow`. This pins
// the legacy `PrincipalRow` shape those readers depend on: name (from prose),
// `data.owner_id` (from extra), `data.created_by` (from the column).

const mocks = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));
vi.mock("../client.js", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn(mocks.db),
}));

import { getPrincipalById, listPrincipals } from "../repo.js";

const ORG = "workspace_pfold00000000000000";
const DOCO = "doco_pfold0000000000000000000000";
const USER = "user_pfold0000000000000000000000";
const P1 = "principal_pfold1000000000000000";
const P2 = "principal_pfold2000000000000000";

beforeAll(async () => {
  mocks.db = await freshDb();
  await mocks.db.query("INSERT INTO workspaces (id, handle, name) VALUES ($1,'pfold','PFold')", [
    ORG,
  ]);
  await mocks.db.query("INSERT INTO users (id, data) VALUES ($1,'{}')", [USER]);
  await mocks.db.query(
    "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ($1,'pfold',$2,$2,'{}'::jsonb)",
    [DOCO, ORG],
  );
  // Two principals: "alice" carries an owner_id in extra; "bob" is bare.
  await mocks.db.query(
    `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, extra, created_by)
       VALUES ($1,$2,'principal','active','alice','{"owner_id":"user_x"}'::jsonb,$3)`,
    [P1, DOCO, USER],
  );
  await mocks.db.query(
    `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, extra)
       VALUES ($1,$2,'principal','active','bob','{}'::jsonb)`,
    [P2, DOCO],
  );
});

describe("principal read folded onto the canonical node path", () => {
  it("getPrincipalById surfaces name (prose), owner_id (extra), created_by (column)", async () => {
    const p = await getPrincipalById(P1);
    expect(p).not.toBeNull();
    expect(p?.id).toBe(P1);
    expect(p?.prose).toBe("alice");
    expect(p?.doco_id).toBe(DOCO);
    expect(p?.extra.owner_id).toBe("user_x");
    expect(p?.created_by).toBe(USER);
  });

  it("returns null for a missing / non-principal id", async () => {
    expect(await getPrincipalById("principal_missing00000000000000")).toBeNull();
  });

  it("listPrincipals returns every principal, name-ordered", async () => {
    const rows = await listPrincipals(DOCO);
    expect(rows.map((r) => r.prose)).toEqual(["alice", "bob"]);
    expect(rows.find((r) => r.prose === "alice")?.extra.owner_id).toBe("user_x");
  });
});
