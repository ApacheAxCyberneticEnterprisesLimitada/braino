import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the REAL repo functions against the REAL schema by pointing
// withClient at an in-process PGlite (its .query matches pg's PoolClient).
const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

const mocks = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));
vi.mock("../client.js", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn(mocks.db),
}));

import {
  cancelAccessRequest,
  createAccessRequest,
  decideAccessRequest,
  getAccessRequest,
  listPendingAccessRequestsForDocos,
} from "../repo.js";

const ORG = "organization_test000000000000000";
const DOCO = "doco_test0000000000000000000000";
const DOCO2 = "doco_test200000000000000000000";
const OWNER = "user_owner00000000000000000000";
const REQ = "user_req0000000000000000000000";

async function seed(): Promise<void> {
  const db = mocks.db;
  await db.query("INSERT INTO users (id, data) VALUES ($1,'{}'),($2,'{}')", [OWNER, REQ]);
  await db.query(
    "INSERT INTO organizations (id, handle, name, data) VALUES ($1,'org','Org','{}')",
    [ORG],
  );
  await db.query(
    "INSERT INTO docos (id, handle, owner_id, org_id, data) VALUES ($1,'d1',$2,$2,'{}'),($3,'d2',$2,$2,'{}')",
    [DOCO, ORG, DOCO2],
  );
}

describe("access requests", () => {
  beforeEach(async () => {
    mocks.db = new PGlite();
    await mocks.db.exec(schemaSql);
    await seed();
  });

  it("creates a pending request", async () => {
    const row = await createAccessRequest({
      doco_id: DOCO,
      requester_id: REQ,
      requested_role: "writer",
      reason: "need to capture decisions",
    });
    expect(row).toMatchObject({
      doco_id: DOCO,
      requester_id: REQ,
      requested_role: "writer",
      status: "pending",
      reason: "need to capture decisions",
    });
    expect(row.id).toMatch(/^accreq_/);
  });

  it("re-requesting updates the live request instead of duplicating", async () => {
    const a = await createAccessRequest({
      doco_id: DOCO,
      requester_id: REQ,
      requested_role: "reader",
    });
    const b = await createAccessRequest({
      doco_id: DOCO,
      requester_id: REQ,
      requested_role: "writer",
      reason: "actually need write",
    });
    expect(b.id).toBe(a.id);
    expect(b.requested_role).toBe("writer");
    expect(await listPendingAccessRequestsForDocos([DOCO])).toHaveLength(1);
  });

  it("lists pending requests across an owner's docos, oldest first", async () => {
    await createAccessRequest({ doco_id: DOCO2, requester_id: REQ, requested_role: "reader" });
    await createAccessRequest({ doco_id: DOCO, requester_id: REQ, requested_role: "writer" });
    const pending = await listPendingAccessRequestsForDocos([DOCO, DOCO2]);
    expect(pending.map((p) => p.doco_id)).toEqual([DOCO2, DOCO]);
  });

  it("approves a pending request once; a second decide is a no-op", async () => {
    const req = await createAccessRequest({
      doco_id: DOCO,
      requester_id: REQ,
      requested_role: "writer",
    });
    const decided = await decideAccessRequest({
      id: req.id,
      status: "approved",
      decided_by: OWNER,
    });
    expect(decided).toMatchObject({ status: "approved", decided_by: OWNER });
    expect(decided?.decided_at).not.toBeNull();
    const again = await decideAccessRequest({ id: req.id, status: "denied", decided_by: OWNER });
    expect(again).toBeNull();
  });

  it("frees a new pending request after the prior one is decided", async () => {
    const a = await createAccessRequest({
      doco_id: DOCO,
      requester_id: REQ,
      requested_role: "reader",
    });
    await decideAccessRequest({ id: a.id, status: "denied", decided_by: OWNER });
    const b = await createAccessRequest({
      doco_id: DOCO,
      requester_id: REQ,
      requested_role: "writer",
    });
    expect(b.id).not.toBe(a.id);
    expect(await listPendingAccessRequestsForDocos([DOCO])).toHaveLength(1);
  });

  it("lets the requester cancel their own pending request", async () => {
    const req = await createAccessRequest({
      doco_id: DOCO,
      requester_id: REQ,
      requested_role: "reader",
    });
    await cancelAccessRequest(req.id, REQ);
    expect(await listPendingAccessRequestsForDocos([DOCO])).toHaveLength(0);
    expect((await getAccessRequest(req.id))?.status).toBe("cancelled");
  });

  it("rejects an invalid requested_role at the schema level", async () => {
    await expect(
      createAccessRequest({
        doco_id: DOCO,
        requester_id: REQ,
        // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid role.
        requested_role: "superuser" as any,
      }),
    ).rejects.toThrow();
  });

  it("cascades when the doco is deleted", async () => {
    const req = await createAccessRequest({
      doco_id: DOCO,
      requester_id: REQ,
      requested_role: "writer",
    });
    await mocks.db.query("DELETE FROM docos WHERE id = $1", [DOCO]);
    expect(await getAccessRequest(req.id)).toBeNull();
  });

  it("returns an empty list when no doco ids are given", async () => {
    expect(await listPendingAccessRequestsForDocos([])).toEqual([]);
  });
});
