// 2026-10-28 security review: the changeset cascade `retire_active_edges`
// retires every active edge on a node, whatever its type, so the write gate
// needs the types it would retire before anything runs.

import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "./fresh-db.js";

const mocks = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));
vi.mock("../client.js", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn(mocks.db),
}));

import { listActiveEdgeTypesForNode } from "../repo.js";

const ORG = "workspace_edgetypes000000000000";
const COLLECTION = "collection_edgetypes0000000000000000000";
const OTHER_COLLECTION = "collection_edgetypes0000000000000000001";
const NODE = "decision_edgetypes000000000000000";
const PEER = "intent_edgetypes00000000000000000";
const FAR = "intent_edgetypes00000000000000001";

async function seedNode(id: string, collectionId: string): Promise<void> {
  await mocks.db.query(
    "INSERT INTO nodes (id, collection_id, node_type, lifecycle) VALUES ($1,$2,$3,'active')",
    [id, collectionId, id.split("_")[0]],
  );
}

async function seedEdge(
  id: string,
  edgeType: string,
  fromId: string,
  toId: string,
  lifecycle: string,
  collectionId = COLLECTION,
): Promise<void> {
  await mocks.db.query(
    `INSERT INTO edges (id, collection_id, edge_type, from_id, from_node_type, to_id, to_node_type, lifecycle)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, collectionId, edgeType, fromId, fromId.split("_")[0], toId, toId.split("_")[0], lifecycle],
  );
}

beforeEach(async () => {
  mocks.db = await freshDb();
  await mocks.db.query("INSERT INTO workspaces (id, handle, name) VALUES ($1,'et','ET')", [ORG]);
  await mocks.db.query(
    `INSERT INTO collections (id, handle, owner_id, workspace_id, data)
     VALUES ($1,'et',$3,$3,'{}'),($2,'et2',$3,$3,'{}')`,
    [COLLECTION, OTHER_COLLECTION, ORG],
  );
  await seedNode(NODE, COLLECTION);
  await seedNode(PEER, COLLECTION);
  await seedNode(FAR, OTHER_COLLECTION);
});

describe("listActiveEdgeTypesForNode", () => {
  it("names each type once, in either direction, active edges only, this collection only", async () => {
    await seedEdge("edge_et0000000000000000000000001", "supports", NODE, PEER, "active");
    await seedEdge("edge_et0000000000000000000000002", "supports", PEER, NODE, "active");
    await seedEdge("edge_et0000000000000000000000003", "constrained_by", PEER, NODE, "active");
    await seedEdge("edge_et0000000000000000000000004", "relates_to", NODE, PEER, "retired");
    await seedEdge(
      "edge_et0000000000000000000000005",
      "blocks",
      NODE,
      FAR,
      "active",
      OTHER_COLLECTION,
    );

    expect(await listActiveEdgeTypesForNode(COLLECTION, NODE)).toEqual([
      "constrained_by",
      "supports",
    ]);
  });

  it("is empty for a node with no active edges", async () => {
    expect(await listActiveEdgeTypesForNode(COLLECTION, NODE)).toEqual([]);
  });
});
