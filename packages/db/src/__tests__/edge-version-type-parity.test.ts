// Parity: an edge version must record its *specific* type, exactly as a node
// version records its node type. Nodes and edges are peers — neither is
// special-cased — so `edge_versions.entity_type` carries `flows_to`, not a
// flattened constant `'edge'`. `entity_type` is not a hash-chain input, so
// stamping the real type leaves history verifiable.

import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { createChangeset, createEdge, retireEdge, updateEdge, verifyHistory } from "../index.js";
import { freshDb } from "./fresh-db.js";

const ORG = "workspace_edgeverparity000000000";
const DOCO = "doco_edgeverparity0000000000000000";
const FROM = "decision_edgeverparity0000000000";
const TO = "action_edgeverparity000000000000";

let db: PGlite;
type Client = Parameters<typeof createEdge>[0];

async function seedNode(id: string, type: string): Promise<void> {
  await db.query(
    "INSERT INTO nodes (id, doco_id, node_type, lifecycle) VALUES ($1,$2,$3,'active')",
    [id, DOCO, type],
  );
}

async function entityTypesFor(edgeId: string): Promise<string[]> {
  const { rows } = await db.query<{ entity_type: string }>(
    "SELECT entity_type FROM edge_versions WHERE entity_id = $1 ORDER BY version",
    [edgeId],
  );
  return rows.map((r) => r.entity_type);
}

beforeEach(async () => {
  db = await freshDb();
  await db.query("INSERT INTO workspaces (id, handle, name) VALUES ($1,'ep','EP')", [ORG]);
  await db.query(
    "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ($1,'ep',$2,$2,'{}')",
    [DOCO, ORG],
  );
  await seedNode(FROM, "decision");
  await seedNode(TO, "action");
});

describe("edge version records its specific type (parity with nodes)", () => {
  it("stamps the edge type on create, update, and retire — never a generic 'edge'", async () => {
    const client = db as unknown as Client;

    const tx1 = await createChangeset(client, { docoId: DOCO, source: "api" });
    const edge = await createEdge(client, tx1, {
      docoId: DOCO,
      edgeType: "flows_to",
      fromId: FROM,
      fromNodeType: "decision",
      toId: TO,
      toNodeType: "action",
      lifecycle: "active",
    });

    const tx2 = await createChangeset(client, { docoId: DOCO, source: "api" });
    await updateEdge(client, tx2, { id: edge.id, label: "Yes" });

    const tx3 = await createChangeset(client, { docoId: DOCO, source: "api" });
    await retireEdge(client, tx3, { id: edge.id });

    // Every version row carries the real type, like node_versions does.
    expect(await entityTypesFor(edge.id)).toEqual(["flows_to", "flows_to", "flows_to"]);

    // Stamping the real type must not disturb the Merkle hash chain.
    const verdict = await verifyHistory(client, "edge", edge.id);
    expect(verdict.ok).toBe(true);
    expect(verdict.versions).toBe(3);
  });
});
