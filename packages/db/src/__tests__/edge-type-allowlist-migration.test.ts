// Each Doco template now declares which relationship edge types it permits via
// a `requires_edge_type` policy (the edge analogue of the node-type allowlist).
// New Docos get it at seed time; the schema.sql migration backfills already-
// seeded Docos, one template at a time, identified by that template's node-type
// allowlist fingerprint. This test seeds a Doco with each template's node-type
// allowlist (WITHOUT the edge allowlist), re-applies the baseline (what every
// boot does), and asserts the right edge allowlist is inserted — idempotently,
// scoped per template, and never duplicated.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, schemaSql } from "./fresh-db.js";

let db: PGlite;

async function ensureDoco(id: string): Promise<void> {
  await db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('workspace_test', 'ws', 'WS')
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO docos (id, handle, owner_id, workspace_id, data)
      VALUES ('${id}', '${id}', 'workspace_test', 'workspace_test', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
  `);
}

/** Seed a template's node-type allowlist — the fingerprint the migration matches on. */
async function seedNodeTypeAllowlist(docoId: string, nodeTypes: string[]): Promise<void> {
  await ensureDoco(docoId);
  const id = `policy_nt_${Math.random().toString(36).slice(2)}`;
  const data = {
    id,
    doco_id: docoId,
    kind: "deterministic",
    predicate: { sub_kind: "requires_node_type", node_types: nodeTypes },
    on_violation: "block",
  };
  await db.query(
    `INSERT INTO policies (id, doco_id, kind, data, lifecycle)
       VALUES ($1, $2, 'deterministic', $3::jsonb, 'active')`,
    [id, docoId, JSON.stringify(data)],
  );
}

interface EdgeAllowlistRow {
  id: string;
  edge_types: string[];
  on_violation: string | null;
  template_handle: string | null;
}

async function edgeAllowlist(docoId: string): Promise<EdgeAllowlistRow[]> {
  const r = await db.query<{ id: string; data: Record<string, unknown> }>(
    `SELECT id, data FROM policies
      WHERE doco_id = $1
        AND lifecycle = 'active'
        AND data -> 'predicate' ->> 'sub_kind' = 'requires_edge_type'`,
    [docoId],
  );
  return r.rows.map((row) => {
    const data = (typeof row.data === "string" ? JSON.parse(row.data) : row.data) as Record<
      string,
      unknown
    >;
    const predicate = data.predicate as { edge_types?: string[] };
    return {
      id: row.id,
      edge_types: predicate.edge_types ?? [],
      on_violation: (data.on_violation as string) ?? null,
      template_handle: (data.template_handle as string) ?? null,
    };
  });
}

const BP_NODES = [
  "intent",
  "action",
  "decision",
  "state",
  "eval",
  "reference",
  "rule",
  "principal",
];
const ORG_NODES = ["principal", "intent", "decision", "reference", "rule"];
const GLOSSARY_NODES = ["decision", "rule", "reference", "eval"];
const DECISION_NODES = ["intent", "decision", "eval", "reference", "rule", "principal"];

describe("edge-type allowlist (requires_edge_type) backfill migration", () => {
  beforeEach(async () => {
    db = await freshDb();
  });

  it("backfills the business-processes edge allowlist", async () => {
    await seedNodeTypeAllowlist("doco_bp", BP_NODES);
    await db.exec(schemaSql);
    const rows = await edgeAllowlist("doco_bp");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.on_violation).toBe("block");
    expect(rows[0]?.template_handle).toBe("process");
    expect(new Set(rows[0]?.edge_types)).toEqual(
      new Set([
        "flows_to",
        "supports",
        "attributed_to",
        "constrained_by",
        "replaces",
        "derived_from",
      ]),
    );
  });

  it("backfills the org-chart edge allowlist (different set, has_parent allowed, flows_to barred)", async () => {
    await seedNodeTypeAllowlist("doco_org", ORG_NODES);
    await db.exec(schemaSql);
    const rows = await edgeAllowlist("doco_org");
    expect(rows).toHaveLength(1);
    expect(new Set(rows[0]?.edge_types)).toEqual(
      new Set([
        "has_parent",
        "attributed_to",
        "relates_to",
        "supports",
        "replaces",
        "derived_from",
      ]),
    );
    expect(rows[0]?.edge_types).not.toContain("flows_to");
  });

  it("backfills the glossaries and decision-record allowlists", async () => {
    await seedNodeTypeAllowlist("doco_gloss", GLOSSARY_NODES);
    await seedNodeTypeAllowlist("doco_dec", DECISION_NODES);
    await db.exec(schemaSql);
    expect(new Set((await edgeAllowlist("doco_gloss"))[0]?.edge_types)).toEqual(
      new Set(["relates_to", "derived_from", "replaces", "supports"]),
    );
    expect(new Set((await edgeAllowlist("doco_dec"))[0]?.edge_types)).toEqual(
      new Set(["supports", "attributed_to", "relates_to", "replaces", "derived_from"]),
    );
  });

  it("is idempotent — a second boot adds no duplicate", async () => {
    await seedNodeTypeAllowlist("doco_bp", BP_NODES);
    await db.exec(schemaSql);
    expect(await edgeAllowlist("doco_bp")).toHaveLength(1);
    await db.exec(schemaSql);
    expect(await edgeAllowlist("doco_bp")).toHaveLength(1);
  });

  it("does not add an edge allowlist for an unrecognized node-type set", async () => {
    await seedNodeTypeAllowlist("doco_weird", ["intent", "action"]); // matches no template
    await db.exec(schemaSql);
    expect(await edgeAllowlist("doco_weird")).toHaveLength(0);
  });

  it("does not add a second allowlist when one already exists", async () => {
    await seedNodeTypeAllowlist("doco_bp", BP_NODES);
    const existingId = "policy_01EXISTINGEDGEALLOWLIST001";
    const data = {
      id: existingId,
      doco_id: "doco_bp",
      kind: "deterministic",
      predicate: { sub_kind: "requires_edge_type", edge_types: ["flows_to"] },
      on_violation: "block",
    };
    await db.query(
      `INSERT INTO policies (id, doco_id, kind, data, lifecycle)
         VALUES ($1, 'doco_bp', 'deterministic', $2::jsonb, 'active')`,
      [existingId, JSON.stringify(data)],
    );
    await db.exec(schemaSql);
    const rows = await edgeAllowlist("doco_bp");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(existingId);
  });
});
