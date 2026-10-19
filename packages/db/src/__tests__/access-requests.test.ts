import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "./fresh-db.js";

// Exercise the REAL repo functions against the REAL schema by pointing
// withClient at an in-process PGlite (its .query matches pg's PoolClient).
const mocks = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));
vi.mock("../client.js", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn(mocks.db),
}));

import {
  cancelAccessRequest,
  createAccessRequest,
  decideAccessRequest,
  getAccessRequest,
  listPendingAccessRequestCountsByCollection,
  listPendingAccessRequestsForCollections,
} from "../repo.js";

const ORG = "workspace_test000000000000000";
const COLLECTION = "collection_test0000000000000000000000";
const COLLECTION2 = "collection_test200000000000000000000";
const OWNER = "user_owner00000000000000000000";
const REQ = "user_req0000000000000000000000";
const REQ2 = "user_req2000000000000000000000";

async function seed(): Promise<void> {
  const db = mocks.db;
  await db.query("INSERT INTO users (id, data) VALUES ($1,'{}'),($2,'{}')", [OWNER, REQ]);
  await db.query(
    "INSERT INTO workspaces (id, handle, name) VALUES ($1, 'workspace', 'Workspace')",
    [ORG],
  );
  await db.query(
    "INSERT INTO collections (id, handle, owner_id, workspace_id, data) VALUES ($1,'d1',$2,$2,'{}'),($3,'d2',$2,$2,'{}')",
    [COLLECTION, ORG, COLLECTION2],
  );
}

describe("access requests", () => {
  beforeEach(async () => {
    mocks.db = await freshDb();
    await seed();
  });

  it("creates a pending request", async () => {
    const row = await createAccessRequest({
      collection_id: COLLECTION,
      requester_id: REQ,
      requested_role: "writer",
      reason: "need to capture decisions",
    });
    expect(row).toMatchObject({
      collection_id: COLLECTION,
      requester_id: REQ,
      requested_role: "writer",
      status: "pending",
      reason: "need to capture decisions",
    });
    expect(row.id).toMatch(/^accreq_/);
  });

  it("re-requesting updates the live request instead of duplicating", async () => {
    const a = await createAccessRequest({
      collection_id: COLLECTION,
      requester_id: REQ,
      requested_role: "reader",
    });
    const b = await createAccessRequest({
      collection_id: COLLECTION,
      requester_id: REQ,
      requested_role: "writer",
      reason: "actually need write",
    });
    expect(b.id).toBe(a.id);
    expect(b.requested_role).toBe("writer");
    expect(await listPendingAccessRequestsForCollections([COLLECTION])).toHaveLength(1);
  });

  it("lists pending requests across an owner's collections, oldest first", async () => {
    const first = await createAccessRequest({
      collection_id: COLLECTION2,
      requester_id: REQ,
      requested_role: "reader",
    });
    // Force a deterministic created_at gap: two same-instant now() inserts
    // would make the ASC order ambiguous (there's no serial column to
    // tiebreak on), so back-date the first request a second.
    await mocks.db.query(
      "UPDATE access_requests SET created_at = now() - interval '1 second' WHERE id = $1",
      [first.id],
    );
    await createAccessRequest({
      collection_id: COLLECTION,
      requester_id: REQ,
      requested_role: "writer",
    });
    const pending = await listPendingAccessRequestsForCollections([COLLECTION, COLLECTION2]);
    expect(pending.map((p) => p.collection_id)).toEqual([COLLECTION2, COLLECTION]);
  });

  it("approves a pending request once; a second decide is a no-op", async () => {
    const req = await createAccessRequest({
      collection_id: COLLECTION,
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
      collection_id: COLLECTION,
      requester_id: REQ,
      requested_role: "reader",
    });
    await decideAccessRequest({ id: a.id, status: "denied", decided_by: OWNER });
    const b = await createAccessRequest({
      collection_id: COLLECTION,
      requester_id: REQ,
      requested_role: "writer",
    });
    expect(b.id).not.toBe(a.id);
    expect(await listPendingAccessRequestsForCollections([COLLECTION])).toHaveLength(1);
  });

  it("lets the requester cancel their own pending request", async () => {
    const req = await createAccessRequest({
      collection_id: COLLECTION,
      requester_id: REQ,
      requested_role: "reader",
    });
    await cancelAccessRequest(req.id, REQ);
    expect(await listPendingAccessRequestsForCollections([COLLECTION])).toHaveLength(0);
    expect((await getAccessRequest(req.id))?.status).toBe("cancelled");
  });

  it("rejects an invalid requested_role at the schema level", async () => {
    await expect(
      createAccessRequest({
        collection_id: COLLECTION,
        requester_id: REQ,
        // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid role.
        requested_role: "superuser" as any,
      }),
    ).rejects.toThrow();
  });

  it("cascades when the collection is deleted", async () => {
    const req = await createAccessRequest({
      collection_id: COLLECTION,
      requester_id: REQ,
      requested_role: "writer",
    });
    await mocks.db.query("DELETE FROM collections WHERE id = $1", [COLLECTION]);
    expect(await getAccessRequest(req.id)).toBeNull();
  });

  it("returns an empty list when no collection ids are given", async () => {
    expect(await listPendingAccessRequestsForCollections([])).toEqual([]);
  });

  describe("listPendingAccessRequestCountsByCollection", () => {
    it("returns an empty list when nothing is pending", async () => {
      expect(await listPendingAccessRequestCountsByCollection()).toEqual([]);
    });

    it("counts pending requests per collection with owner_id, ignoring decided ones", async () => {
      // A second requester so two pending on the same collection don't collide on the
      // (collection_id, requester_id) WHERE pending unique constraint.
      await mocks.db.query("INSERT INTO users (id, data) VALUES ($1,'{}')", [REQ2]);
      await createAccessRequest({
        collection_id: COLLECTION,
        requester_id: REQ,
        requested_role: "reader",
      });
      await createAccessRequest({
        collection_id: COLLECTION,
        requester_id: REQ2,
        requested_role: "writer",
      });
      await createAccessRequest({
        collection_id: COLLECTION2,
        requester_id: REQ,
        requested_role: "reader",
      });
      // A decided request must not be counted.
      const decided = await createAccessRequest({
        collection_id: COLLECTION2,
        requester_id: REQ2,
        requested_role: "reader",
      });
      await decideAccessRequest({ id: decided.id, status: "denied", decided_by: OWNER });

      const counts = await listPendingAccessRequestCountsByCollection();
      const byCollection = new Map(counts.map((c) => [c.collection_id, c]));
      expect(counts).toHaveLength(2);
      expect(byCollection.get(COLLECTION)).toEqual({
        collection_id: COLLECTION,
        owner_id: ORG,
        n: 2,
      });
      expect(byCollection.get(COLLECTION2)).toEqual({
        collection_id: COLLECTION2,
        owner_id: ORG,
        n: 1,
      });
    });
  });
});
