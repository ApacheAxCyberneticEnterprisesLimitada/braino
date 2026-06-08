// Global lifecycle invariant: an `active` edge can only belong to `active`
// nodes. A node that is not active cannot carry an active edge. Enforced at the
// single edge-write boundary (createEdge / updateEdge), and reversible via the
// opt-in `retireActiveEdgesForNode` cascade when a node is demoted.

import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  EDGE_ENDPOINTS_NOT_ACTIVE,
  createChangeset,
  createEdge,
  retireActiveEdgesForNode,
  updateEdge,
} from "../index.js";
import { freshDb } from "./fresh-db.js";

const ORG = "workspace_activeedge0000000000";
const DOCO = "doco_activeedge00000000000000000";
const FROM = "decision_activeedge00000000000000";
const TO = "intent_activeedge0000000000000000";

let db: PGlite;
type Client = Parameters<typeof createEdge>[0];

async function seedNode(id: string, type: string, lifecycle: string): Promise<void> {
  await db.query("INSERT INTO nodes (id, doco_id, node_type, lifecycle) VALUES ($1,$2,$3,$4)", [
    id,
    DOCO,
    type,
    lifecycle,
  ]);
}

async function makeEdge(lifecycle: "drafting" | "queued" | "active") {
  const client = db as unknown as Client;
  const tx = await createChangeset(client, { docoId: DOCO, source: "api" });
  return createEdge(client, tx, {
    docoId: DOCO,
    edgeType: "supports",
    fromId: FROM,
    fromNodeType: "decision",
    toId: TO,
    toNodeType: "intent",
    lifecycle,
  });
}

beforeEach(async () => {
  db = await freshDb();
  await db.query("INSERT INTO workspaces (id, handle, name) VALUES ($1,'ae','AE')", [ORG]);
  await db.query(
    "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ($1,'ae',$2,$2,'{}')",
    [DOCO, ORG],
  );
});

describe("active-edge endpoint invariant", () => {
  it("allows an active edge when both endpoints are active", async () => {
    await seedNode(FROM, "decision", "active");
    await seedNode(TO, "intent", "active");
    const edge = await makeEdge("active");
    expect(edge.lifecycle).toBe("active");
  });

  it("rejects creating an active edge when an endpoint is not active", async () => {
    await seedNode(FROM, "decision", "active");
    await seedNode(TO, "intent", "drafting");
    await expect(makeEdge("active")).rejects.toThrow(EDGE_ENDPOINTS_NOT_ACTIVE);
  });

  it("allows a non-active edge to a non-active node", async () => {
    await seedNode(FROM, "decision", "active");
    await seedNode(TO, "intent", "drafting");
    const edge = await makeEdge("drafting");
    expect(edge.lifecycle).toBe("drafting");
  });

  it("rejects transitioning an edge to active when an endpoint is not active", async () => {
    await seedNode(FROM, "decision", "active");
    await seedNode(TO, "intent", "drafting");
    const edge = await makeEdge("drafting");
    const client = db as unknown as Client;
    const tx = await createChangeset(client, { docoId: DOCO, source: "api" });
    await expect(updateEdge(client, tx, { id: edge.id, lifecycle: "active" })).rejects.toThrow(
      EDGE_ENDPOINTS_NOT_ACTIVE,
    );
  });
});

describe("retireActiveEdgesForNode cascade", () => {
  it("retires every active edge touching the node, in both directions", async () => {
    await seedNode(FROM, "decision", "active");
    await seedNode(TO, "intent", "active");
    const other = "action_activeedge0000000000000000";
    await seedNode(other, "action", "active");

    const client = db as unknown as Client;
    const tx1 = await createChangeset(client, { docoId: DOCO, source: "api" });
    // Outgoing FROM→TO and incoming other→FROM, both active.
    await createEdge(client, tx1, {
      docoId: DOCO,
      edgeType: "supports",
      fromId: FROM,
      fromNodeType: "decision",
      toId: TO,
      toNodeType: "intent",
      lifecycle: "active",
    });
    await createEdge(client, tx1, {
      docoId: DOCO,
      edgeType: "supports",
      fromId: other,
      fromNodeType: "action",
      toId: FROM,
      toNodeType: "decision",
      lifecycle: "active",
    });

    const tx2 = await createChangeset(client, { docoId: DOCO, source: "api" });
    const retired = await retireActiveEdgesForNode(client, tx2, { docoId: DOCO, nodeId: FROM });
    expect(retired).toHaveLength(2);
    expect(retired.every((e) => e.lifecycle === "retired")).toBe(true);

    const { rows } = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM edges WHERE doco_id = $1 AND lifecycle = 'active'",
      [DOCO],
    );
    expect(rows[0].n).toBe("0");
  });
});
