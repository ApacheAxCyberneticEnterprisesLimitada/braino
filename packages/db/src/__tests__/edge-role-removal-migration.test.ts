// Edge `role` is fully retired: an edge's meaning now comes from its TYPE plus
// its endpoint node types, never a `props.role` tag. The "Edge `role` removal"
// migration in schema.sql converges already-seeded production data onto the new
// model. This test seeds data in the OLD (role-bearing) shape, re-applies the
// baseline (what every boot does), and asserts:
//
//   (1a) the actor-coverage gate (requires_edge_role / performed_by / incoming /
//        exempt_when_role: owned_by) becomes requires_edge with
//        target_node_type:action + exempt_when_other_node_type:intent, and loses
//        edge_role + exempt_when_role.
//   (1b) every other requires_edge_role → requires_edge (edge_role dropped).
//   (1c) limits_edge_role → limits_edge (edge_role dropped).
//   (1d) an edge-scoped probabilistic policy loses its edge_role.
//   (2)  every edge loses props.role, and two live edges that differ ONLY by
//        role between the same (doco, from, to, type) are deduped to one live
//        edge (the oldest kept, the rest retired) under the role-free index.
//
// It also asserts idempotency: a second re-exec is a no-op.
//
// Mirrors the structure of the sibling migration tests (construct a PGlite, exec
// schema.sql, insert rows, re-exec, assert).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

let db: PGlite;

const DOCO = "doco_roleremoval";

async function ensureDoco(): Promise<void> {
  await db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('workspace_test', 'ws', 'WS')
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO docos (id, handle, owner_id, workspace_id, data)
      VALUES ('${DOCO}', '${DOCO}', 'workspace_test', 'workspace_test', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
  `);
}

/** Insert a deterministic / probabilistic policy carrying the given predicate. */
async function seedPolicy(
  id: string,
  kind: "deterministic" | "probabilistic",
  predicate: Record<string, unknown>,
  extras: Record<string, unknown> = {},
): Promise<void> {
  await ensureDoco();
  const data = {
    id,
    doco_id: DOCO,
    kind,
    predicate,
    on_violation: "block",
    ...extras,
  };
  await db.query(
    `INSERT INTO policies (id, doco_id, kind, data, lifecycle)
       VALUES ($1, $2, $3, $4::jsonb, 'active')`,
    [id, DOCO, kind, JSON.stringify(data)],
  );
}

async function predicateOf(id: string): Promise<Record<string, unknown>> {
  const r = await db.query<{ data: Record<string, unknown> }>(
    "SELECT data FROM policies WHERE id = $1",
    [id],
  );
  const data = (
    typeof r.rows[0].data === "string"
      ? JSON.parse(r.rows[0].data as unknown as string)
      : r.rows[0].data
  ) as Record<string, unknown>;
  return data.predicate as Record<string, unknown>;
}

async function insertNode(id: string, nodeType: string): Promise<void> {
  // `nodes.data` was dropped (per-node data lives in `attributes` now); the
  // role-removal migration only touches edges + policies, so a bare node row
  // (just enough to satisfy edge FKs + carry the entity-type id prefix) is fine.
  await db.query(
    `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose)
       VALUES ($1, $2, $3, 'active', '')`,
    [id, DOCO, nodeType],
  );
}

interface EdgeShape {
  id: string;
  lifecycle: string;
  label: string | null;
}
async function edgesBetween(from: string, to: string, edgeType: string): Promise<EdgeShape[]> {
  const r = await db.query<EdgeShape>(
    `SELECT id, lifecycle, label
       FROM edges
      WHERE doco_id = $1 AND from_id = $2 AND to_id = $3 AND edge_type = $4
      ORDER BY created_at, id`,
    [DOCO, from, to, edgeType],
  );
  return r.rows;
}

describe("edge `role` removal migration", () => {
  beforeEach(async () => {
    db = new PGlite();
    await db.exec(schemaSql); // fresh baseline (migration is a no-op on an empty DB)
  });

  // ── (1) Policy conversions ────────────────────────────────────────────────

  it("(1a) rewrites the actor-coverage gate to a structural requires_edge", async () => {
    await seedPolicy("policy_coverage", "deterministic", {
      sub_kind: "requires_edge_role",
      edge_type: "attributed_to",
      edge_role: "performed_by",
      direction: "incoming",
      exempt_when_role: "owned_by",
      when_node_type: ["principal"],
    });

    await db.exec(schemaSql); // re-apply baseline — what every boot does

    const pred = await predicateOf("policy_coverage");
    expect(pred.sub_kind).toBe("requires_edge");
    expect(pred.edge_type).toBe("attributed_to");
    expect(pred.direction).toBe("incoming");
    // Re-expressed structurally: far end is an Action, exempt when an Intent.
    expect(pred.target_node_type).toBe("action");
    expect(pred.exempt_when_other_node_type).toBe("intent");
    expect(pred.when_node_type).toEqual(["principal"]);
    // The retired role fields are gone.
    expect(pred.edge_role).toBeUndefined();
    expect(pred.exempt_when_role).toBeUndefined();
  });

  it("(1b) rewrites every other requires_edge_role → requires_edge, dropping edge_role", async () => {
    // The Action-performer gate: requires_edge_role(attributed_to / performed_by
    // / principal) → requires_edge(attributed_to → principal). The distinction
    // that used to ride on the role now lives on edge_type + target_node_type.
    await seedPolicy("policy_performer", "deterministic", {
      sub_kind: "requires_edge_role",
      edge_type: "attributed_to",
      edge_role: "performed_by",
      target_node_type: "principal",
      when_node_type: ["action"],
    });

    await db.exec(schemaSql);

    const pred = await predicateOf("policy_performer");
    expect(pred.sub_kind).toBe("requires_edge");
    expect(pred.edge_type).toBe("attributed_to");
    expect(pred.target_node_type).toBe("principal");
    expect(pred.when_node_type).toEqual(["action"]);
    expect(pred.edge_role).toBeUndefined();
  });

  it("(1c) rewrites limits_edge_role → limits_edge, dropping edge_role", async () => {
    await seedPolicy("policy_ceiling", "deterministic", {
      sub_kind: "limits_edge_role",
      edge_type: "supports",
      edge_role: "serves",
      target_node_type: "intent",
      max_count: 1,
      when_node_type: ["action", "decision", "state"],
    });

    await db.exec(schemaSql);

    const pred = await predicateOf("policy_ceiling");
    expect(pred.sub_kind).toBe("limits_edge");
    expect(pred.edge_type).toBe("supports");
    expect(pred.target_node_type).toBe("intent");
    expect(pred.max_count).toBe(1);
    expect(pred.when_node_type).toEqual(["action", "decision", "state"]);
    expect(pred.edge_role).toBeUndefined();
  });

  it("(1d) drops edge_role from an edge-scoped probabilistic policy", async () => {
    await seedPolicy("policy_subproc", "probabilistic", {
      agent_instruction: "Intent name is the base form of the Action it serves.",
      edge_type: "supports",
      edge_role: "serves",
      from_node_type: "action",
      to_node_type: "intent",
    });

    await db.exec(schemaSql);

    const pred = await predicateOf("policy_subproc");
    expect(pred.edge_type).toBe("supports");
    expect(pred.from_node_type).toBe("action");
    expect(pred.to_node_type).toBe("intent");
    expect(pred.agent_instruction).toMatch(/base form/i);
    expect(pred.edge_role).toBeUndefined();
  });

  // ── (2) Edges: strip props.role + dedup collapsing live edges ──────────────

  it("(2) folds props.{label,condition,kind} into columns, drops props, and dedups colliding live edges", async () => {
    await ensureDoco();
    await insertNode("action_a", "action");
    await insertNode("principal_p", "principal");
    await insertNode("intent_i", "intent");

    // Simulate a pre-Slice-2 DB: drop the typed columns (an existing prod
    // `edges` table never got them — `CREATE TABLE IF NOT EXISTS` is a no-op
    // there), re-add the dropped `props` jsonb and the OLD role-bearing
    // live-uniqueness index, so we can plant TWO live edges that differ ONLY by
    // role between the same (doco, from, to, type), plus a flows_to edge whose
    // label/condition/kind live in props. On re-exec, the migration must FIRST
    // re-add the typed columns (else the fold's `SET label = …` aborts the whole
    // schema apply), then dedup, fold props.{label,condition,kind}, and DROP props.
    await db.exec("ALTER TABLE edges DROP COLUMN label, DROP COLUMN condition, DROP COLUMN kind;");
    await db.exec("ALTER TABLE edges ADD COLUMN IF NOT EXISTS props jsonb;");
    await db.exec("DROP INDEX IF EXISTS edges_live_uniq;");
    await db.exec(
      `CREATE UNIQUE INDEX edges_live_uniq
         ON edges (doco_id, from_id, to_id, edge_type, (props->>'role'))
        WHERE lifecycle <> 'retired';`,
    );
    const insertEdge = (
      id: string,
      from: string,
      fromT: string,
      to: string,
      toT: string,
      edgeType: string,
      props: Record<string, unknown>,
      createdAt: string,
    ) =>
      db.query(
        `INSERT INTO edges (id, doco_id, edge_type, from_id, from_node_type, to_id, to_node_type, props, lifecycle, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'active',$9,$9)`,
        [id, DOCO, edgeType, from, fromT, to, toT, JSON.stringify(props), createdAt],
      );
    // Two attributed_to edges from the Action to the same Principal, differing
    // only by role (a performer + a decider attribution that used to coexist).
    await insertEdge(
      "edge_perf",
      "action_a",
      "action",
      "principal_p",
      "principal",
      "attributed_to",
      { role: "performed_by" },
      "2026-01-01T00:00:00Z",
    );
    await insertEdge(
      "edge_dec",
      "action_a",
      "action",
      "principal_p",
      "principal",
      "attributed_to",
      { role: "decided_by" },
      "2026-02-01T00:00:00Z",
    );
    // A flows_to edge whose label/condition/kind must fold into the new columns.
    await insertEdge(
      "edge_flow",
      "action_a",
      "action",
      "intent_i",
      "intent",
      "flows_to",
      { label: "approved", condition: "amount > 0", kind: "timer" },
      "2026-01-01T00:00:00Z",
    );
    // Flush the DEFERRABLE INITIALLY DEFERRED edge→node FK checks now (the nodes
    // exist, so they pass), so the migration's CREATE INDEX isn't blocked by
    // "pending trigger events".
    await db.exec("SET CONSTRAINTS ALL IMMEDIATE;");

    await db.exec(schemaSql); // re-apply baseline — runs the Slice-2 edge migration

    // The `props` column is gone entirely.
    const cols = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'edges'",
    );
    expect(cols.rows.map((r) => r.column_name)).not.toContain("props");

    // The colliding pair collapses to exactly one LIVE edge; the oldest
    // (edge_perf, created first) is kept and the other retired.
    const collided = await edgesBetween("action_a", "principal_p", "attributed_to");
    expect(collided).toHaveLength(2);
    const live = collided.filter((e) => e.lifecycle !== "retired");
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe("edge_perf");
    expect(collided.find((e) => e.id === "edge_dec")?.lifecycle).toBe("retired");

    // The flows_to edge stays live, with its metadata folded into typed columns.
    const flow = await edgesBetween("action_a", "intent_i", "flows_to");
    expect(flow).toHaveLength(1);
    expect(flow[0].lifecycle).toBe("active");
    expect(flow[0].label).toBe("approved");
    const folded = await db.query<{ condition: string | null; kind: string | null }>(
      "SELECT condition, kind FROM edges WHERE id = 'edge_flow'",
    );
    expect(folded.rows[0].condition).toBe("amount > 0");
    expect(folded.rows[0].kind).toBe("timer");

    // The role-free unique index now holds: a second colliding live edge is
    // rejected, proving the index was recreated role-free.
    await expect(
      db.query(
        `INSERT INTO edges (id, doco_id, edge_type, from_id, from_node_type, to_id, to_node_type, lifecycle)
           VALUES ('edge_dupe', $1, 'attributed_to', 'action_a', 'action', 'principal_p', 'principal', 'active')`,
        [DOCO],
      ),
    ).rejects.toThrow();
  });

  // ── Idempotency ────────────────────────────────────────────────────────────

  it("is idempotent — a second re-exec is a no-op for policies and edges", async () => {
    await seedPolicy("policy_performer", "deterministic", {
      sub_kind: "requires_edge_role",
      edge_type: "attributed_to",
      edge_role: "performed_by",
      target_node_type: "principal",
      when_node_type: ["action"],
    });
    await ensureDoco();
    await insertNode("action_a", "action");
    await insertNode("principal_p", "principal");
    await db.query(
      `INSERT INTO edges (id, doco_id, edge_type, from_id, from_node_type, to_id, to_node_type, lifecycle)
         VALUES ('edge_one', $1, 'attributed_to', 'action_a', 'action', 'principal_p', 'principal', 'active')`,
      [DOCO],
    );
    await db.exec("SET CONSTRAINTS ALL IMMEDIATE;");

    await db.exec(schemaSql);
    const predAfterFirst = await predicateOf("policy_performer");
    const edgesAfterFirst = await edgesBetween("action_a", "principal_p", "attributed_to");

    // Second boot must not re-touch anything (the UPDATEs match only old-shape
    // rows, now converted; the edge index/dedup is already settled).
    await db.exec(schemaSql);
    expect(await predicateOf("policy_performer")).toEqual(predAfterFirst);
    expect(await edgesBetween("action_a", "principal_p", "attributed_to")).toEqual(edgesAfterFirst);
    expect(predAfterFirst.sub_kind).toBe("requires_edge");
  });
});
