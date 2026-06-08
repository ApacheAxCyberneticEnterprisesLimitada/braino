// Edges carry the SAME four-stage lifecycle as nodes:
//   drafting → queued → active → retired
// `queued` is provisional-but-ready (e.g. an edge awaiting approval). It must
// be settable both at creation and as a transition off an existing edge, and
// persist through the append-only write boundary like any other stage.

import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { createChangeset, createEdge, updateEdge } from "../index.js";
import { freshDb } from "./fresh-db.js";

const ORG = "workspace_queued00000000000000";
const DOCO = "doco_queued00000000000000000000";
const FROM = "decision_queued000000000000000000";
const TO = "intent_queued0000000000000000000";

let db: PGlite;

async function seed(): Promise<void> {
  await db.query("INSERT INTO workspaces (id, handle, name) VALUES ($1, 'queued', 'Queued')", [
    ORG,
  ]);
  await db.query(
    "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ($1,'queued',$2,$2,'{}')",
    [DOCO, ORG],
  );
  for (const [id, type] of [
    [FROM, "decision"],
    [TO, "intent"],
  ] as const) {
    await db.query("INSERT INTO nodes (id, doco_id, node_type) VALUES ($1,$2,$3)", [
      id,
      DOCO,
      type,
    ]);
  }
}

beforeEach(async () => {
  db = await freshDb();
  await seed();
});

describe("edge queued lifecycle", () => {
  it("creates an edge directly in the queued stage", async () => {
    const client = db as unknown as Parameters<typeof createEdge>[0];
    const tx = await createChangeset(client, { docoId: DOCO, source: "api" });
    const edge = await createEdge(client, tx, {
      docoId: DOCO,
      edgeType: "supports",
      fromId: FROM,
      fromNodeType: "decision",
      toId: TO,
      toNodeType: "intent",
      lifecycle: "queued",
    });
    expect(edge.lifecycle).toBe("queued");
  });

  it("transitions a drafting edge to queued via updateEdge", async () => {
    const client = db as unknown as Parameters<typeof createEdge>[0];
    const tx1 = await createChangeset(client, { docoId: DOCO, source: "api" });
    const edge = await createEdge(client, tx1, {
      docoId: DOCO,
      edgeType: "supports",
      fromId: FROM,
      fromNodeType: "decision",
      toId: TO,
      toNodeType: "intent",
      lifecycle: "drafting",
    });

    const tx2 = await createChangeset(client, { docoId: DOCO, source: "api" });
    const queued = await updateEdge(client, tx2, { id: edge.id, lifecycle: "queued" });
    expect(queued.lifecycle).toBe("queued");
    expect(queued.retired_at).toBeNull();
  });
});
