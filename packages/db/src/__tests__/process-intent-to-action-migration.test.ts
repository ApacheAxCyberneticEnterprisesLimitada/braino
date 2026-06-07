// The process model dropped Intent as the pool: a process is now an Action with
// `has_parent` children. Existing `process` Docos modeled pools as Intents and
// membership as `supports` (flow node → Intent). The one-shot
// `process_intent_to_action` migration promotes each such Intent to an Action
// (renaming `intent_<ulid>` → `action_<ulid>` and cascading the id to every
// table that references it) and re-points membership `supports` edges to
// `has_parent`.
//
// This test seeds an old-model `process` Doco, clears the one-shot marker (so a
// re-apply re-runs the guarded block), re-applies the schema, and asserts the
// promotion landed — id rename cascaded, membership converted, and a
// non-process Doco left untouched. Idempotent: a second re-apply is a no-op.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, schemaSql } from "./fresh-db.js";

let db: PGlite;

async function ensureWorkspace(): Promise<void> {
  await db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('workspace_t', 'ws', 'WS')
      ON CONFLICT (id) DO NOTHING;
  `);
}

async function seedDoco(id: string, templateHandle: string | null): Promise<void> {
  await ensureWorkspace();
  await db.query(
    `INSERT INTO docos (id, handle, owner_id, workspace_id, data)
       VALUES ($1, $1, 'workspace_t', 'workspace_t', $2::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    [id, JSON.stringify(templateHandle ? { template_handle: templateHandle } : {})],
  );
}

async function insertNode(
  id: string,
  docoId: string,
  nodeType: string,
  prose: string,
): Promise<void> {
  await db.query("INSERT INTO nodes (id, doco_id, node_type, prose) VALUES ($1,$2,$3,$4)", [
    id,
    docoId,
    nodeType,
    prose,
  ]);
}

async function insertEdge(
  id: string,
  docoId: string,
  edgeType: string,
  from: string,
  fromType: string,
  to: string,
  toType: string,
): Promise<void> {
  await db.query(
    `INSERT INTO edges (id, doco_id, edge_type, from_id, from_node_type, to_id, to_node_type, lifecycle)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active')`,
    [id, docoId, edgeType, from, fromType, to, toType],
  );
}

async function clearMarkerAndReapply(): Promise<void> {
  await db.query("DELETE FROM schema_oneshots WHERE name = 'process_intent_to_action'");
  await db.exec(schemaSql);
}

describe("process_intent_to_action migration", () => {
  beforeEach(async () => {
    db = await freshDb();
  });

  it("promotes a process Doco's Intent to an Action and converts membership to has_parent", async () => {
    await seedDoco("doco_proc", "process");
    // The pool Intent, a member Action, and the process owner Principal.
    await insertNode("intent_01POOL", "doco_proc", "intent", "Approve a consumer loan");
    await insertNode("action_01STEP", "doco_proc", "action", "review the application");
    await insertNode("principal_01OWN", "doco_proc", "principal", "Loan Officer");
    // Membership: the member supports the pool Intent.
    await insertEdge(
      "edge_mem",
      "doco_proc",
      "supports",
      "action_01STEP",
      "action",
      "intent_01POOL",
      "intent",
    );
    // The Intent's owner edge (attributed_to → principal).
    await insertEdge(
      "edge_own",
      "doco_proc",
      "attributed_to",
      "intent_01POOL",
      "intent",
      "principal_01OWN",
      "principal",
    );
    // A control edge that must be left alone (member's performer).
    await insertEdge(
      "edge_perf",
      "doco_proc",
      "attributed_to",
      "action_01STEP",
      "action",
      "principal_01OWN",
      "principal",
    );
    // Auxiliary node-id references that must cascade with the rename.
    await db.query(
      "INSERT INTO embeddings (entity_id, doco_id, model_id, content_hash, embedding) VALUES ('intent_01POOL','doco_proc','m','h','\\x00'::bytea)",
    );
    await db.query(
      "INSERT INTO entity_fts_nodes (entity_id, doco_id, node_type, summary) VALUES ('intent_01POOL','doco_proc','intent','Approve a consumer loan')",
    );
    await db.query(
      "INSERT INTO audit_events (event_id, at, entity_type, entity_id, op) VALUES ('ae_1', now(), 'intent', 'intent_01POOL', 'entity.create')",
    );
    // node_versions history for the pool Intent — the APPEND-ONLY table. Its
    // BEFORE UPDATE/DELETE trigger blocks the migration's id-repoint unless the
    // migration suspends it. A process Doco in production always has this
    // history, so WITHOUT it this test passed while production's cold-start
    // schema apply aborted (`history append-only: UPDATE on node_versions is
    // not allowed`), 500-ing every DB request.
    const cs = await db.query<{ tx_id: number }>(
      "INSERT INTO changesets (doco_id) VALUES ('doco_proc') RETURNING tx_id",
    );
    await db.query(
      "INSERT INTO node_versions (entity_id, entity_type, version, op, payload, tx_id) VALUES ('intent_01POOL','intent',1,'create','{}'::jsonb,$1)",
      [cs.rows[0].tx_id],
    );

    await clearMarkerAndReapply();

    // The Intent is gone; the promoted Action carries its id suffix + prose.
    const intents = await db.query<{ id: string }>(
      "SELECT id FROM nodes WHERE doco_id = 'doco_proc' AND node_type = 'intent'",
    );
    expect(intents.rows).toEqual([]);
    const promoted = await db.query<{ id: string; node_type: string; prose: string }>(
      "SELECT id, node_type, prose FROM nodes WHERE id = 'action_01POOL'",
    );
    expect(promoted.rows[0]).toMatchObject({
      id: "action_01POOL",
      node_type: "action",
      prose: "Approve a consumer loan",
    });

    // Membership edge: supports → has_parent, re-pointed at the promoted Action.
    const mem = await db.query<{ edge_type: string; to_id: string; to_node_type: string }>(
      "SELECT edge_type, to_id, to_node_type FROM edges WHERE id = 'edge_mem'",
    );
    expect(mem.rows[0]).toMatchObject({
      edge_type: "has_parent",
      to_id: "action_01POOL",
      to_node_type: "action",
    });

    // The owner edge's FROM endpoint follows the rename (still attributed_to).
    const own = await db.query<{ edge_type: string; from_id: string; from_node_type: string }>(
      "SELECT edge_type, from_id, from_node_type FROM edges WHERE id = 'edge_own'",
    );
    expect(own.rows[0]).toMatchObject({
      edge_type: "attributed_to",
      from_id: "action_01POOL",
      from_node_type: "action",
    });

    // The control performer edge is untouched.
    const perf = await db.query<{ edge_type: string; from_id: string; to_id: string }>(
      "SELECT edge_type, from_id, to_id FROM edges WHERE id = 'edge_perf'",
    );
    expect(perf.rows[0]).toMatchObject({
      edge_type: "attributed_to",
      from_id: "action_01STEP",
      to_id: "principal_01OWN",
    });

    // Auxiliary references cascaded.
    for (const table of ["embeddings", "entity_fts_nodes"]) {
      const r = await db.query<{ entity_id: string }>(
        `SELECT entity_id FROM ${table} WHERE doco_id = 'doco_proc'`,
      );
      expect(r.rows[0]?.entity_id).toBe("action_01POOL");
    }
    const ae = await db.query<{ entity_id: string }>(
      "SELECT entity_id FROM audit_events WHERE event_id = 'ae_1'",
    );
    expect(ae.rows[0]?.entity_id).toBe("action_01POOL");

    // The append-only history row cascaded with the rename…
    const nv = await db.query<{ entity_id: string }>("SELECT entity_id FROM node_versions");
    expect(nv.rows[0]?.entity_id).toBe("action_01POOL");
    // …and the append-only guard is restored once the one-shot migration is done.
    await expect(
      db.query("UPDATE node_versions SET entity_type = 'x' WHERE entity_id = 'action_01POOL'"),
    ).rejects.toThrow(/append-only/);
  });

  it("leaves Intents in a non-process Doco untouched", async () => {
    await seedDoco("doco_dec", "decision-records");
    await insertNode("intent_01GOAL", "doco_dec", "intent", "Ship the feature");

    await clearMarkerAndReapply();

    const r = await db.query<{ id: string; node_type: string }>(
      "SELECT id, node_type FROM nodes WHERE doco_id = 'doco_dec'",
    );
    expect(r.rows[0]).toMatchObject({ id: "intent_01GOAL", node_type: "intent" });
  });

  it("is idempotent — a second re-apply changes nothing further", async () => {
    await seedDoco("doco_proc", "process");
    await insertNode("intent_01POOL", "doco_proc", "intent", "Approve a consumer loan");
    await insertNode("action_01STEP", "doco_proc", "action", "review the application");
    await insertEdge(
      "edge_mem",
      "doco_proc",
      "supports",
      "action_01STEP",
      "action",
      "intent_01POOL",
      "intent",
    );

    await clearMarkerAndReapply();
    // Re-applying WITHOUT clearing the marker is a guarded no-op.
    await db.exec(schemaSql);

    const promoted = await db.query<{ id: string }>(
      "SELECT id FROM nodes WHERE doco_id = 'doco_proc' AND node_type = 'action'",
    );
    expect(promoted.rows.map((row) => row.id).sort()).toEqual(["action_01POOL", "action_01STEP"]);
    const mem = await db.query<{ edge_type: string }>(
      "SELECT edge_type FROM edges WHERE id = 'edge_mem'",
    );
    expect(mem.rows[0]?.edge_type).toBe("has_parent");
  });
});
