// Reviving a retired edge (lifecycle back to active/drafting) must clear the
// `retired_at` stamp, otherwise the row carries a contradictory state: a
// non-retired lifecycle with a retirement timestamp still set. The edge
// lifecycle buttons in the dialog drive exactly this transition.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { createChangeset, createEdge, retireEdge, updateEdge } from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

const ORG = "workspace_revive00000000000000";
const DOCO = "doco_revive00000000000000000000";
const FROM = "decision_revive000000000000000000";
const TO = "intent_revive0000000000000000000";

let db: PGlite;

async function seed(): Promise<void> {
  await db.query(
    "INSERT INTO workspaces (id, handle, name, data) VALUES ($1,'revive','Revive','{}')",
    [ORG],
  );
  await db.query(
    "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ($1,'revive',$2,$2,'{}')",
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
  db = new PGlite();
  await db.exec(schemaSql);
  await seed();
});

describe("updateEdge reviving a retired edge", () => {
  it("clears retired_at when the lifecycle moves back to active", async () => {
    const client = db as unknown as Parameters<typeof createEdge>[0];
    const tx1 = await createChangeset(client, { docoId: DOCO, source: "api" });
    const edge = await createEdge(client, tx1, {
      docoId: DOCO,
      edgeType: "supports",
      fromId: FROM,
      fromNodeType: "decision",
      toId: TO,
      toNodeType: "intent",
      lifecycle: "active",
    });

    const tx2 = await createChangeset(client, { docoId: DOCO, source: "api" });
    const retired = await retireEdge(client, tx2, { id: edge.id });
    expect(retired.lifecycle).toBe("retired");
    expect(retired.retired_at).not.toBeNull();

    const tx3 = await createChangeset(client, { docoId: DOCO, source: "api" });
    const revived = await updateEdge(client, tx3, { id: edge.id, lifecycle: "active" });
    expect(revived.lifecycle).toBe("active");
    expect(revived.retired_at).toBeNull();
  });

  it("leaves retired_at untouched when only props change", async () => {
    const client = db as unknown as Parameters<typeof createEdge>[0];
    const tx1 = await createChangeset(client, { docoId: DOCO, source: "api" });
    const edge = await createEdge(client, tx1, {
      docoId: DOCO,
      edgeType: "supports",
      fromId: FROM,
      fromNodeType: "decision",
      toId: TO,
      toNodeType: "intent",
      lifecycle: "active",
    });
    const tx2 = await createChangeset(client, { docoId: DOCO, source: "api" });
    await retireEdge(client, tx2, { id: edge.id });

    const tx3 = await createChangeset(client, { docoId: DOCO, source: "api" });
    const updated = await updateEdge(client, tx3, { id: edge.id, props: { note: "x" } });
    expect(updated.lifecycle).toBe("retired");
    expect(updated.retired_at).not.toBeNull();
  });
});
