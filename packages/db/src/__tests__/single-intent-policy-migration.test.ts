// Already-seeded business-processes Docos predate the "a flow node serves AT
// MOST one Intent" ceiling. The template now seeds that gate
// (limits_edge / supports / intent, max 1, firing drafting → queued → active)
// on new Docos; existing Docos must get it too, so no flow node can be wired
// into two BPMN pools.
//
// Edge `role` is retired: the floor and ceiling no longer carry an `edge_role`
// tag — the meaning rides on the edge type + endpoint node types. A
// business-processes Doco is identified by its role-free `serves` attachment
// FLOOR gate (requires_edge / supports / intent), which only that template
// seeds. This test seeds such a Doco WITHOUT the ceiling, re-applies the
// baseline (what every boot does), and asserts the ceiling row is inserted —
// idempotently, scoped to business-processes Docos, and never duplicated.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

let db: PGlite;

async function ensureDoco(id: string): Promise<void> {
  await db.exec(`
    INSERT INTO workspaces (id, handle, name, data)
      VALUES ('workspace_test', 'ws', 'WS', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO docos (id, handle, owner_id, workspace_id, data)
      VALUES ('${id}', '${id}', 'workspace_test', 'workspace_test', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
  `);
}

/** Seed the role-free `serves` attachment FLOOR gate — the business-processes fingerprint. */
async function seedServesFloor(docoId: string): Promise<void> {
  await ensureDoco(docoId);
  const id = `policy_floor_${Math.random().toString(36).slice(2)}`;
  const data = {
    id,
    doco_id: docoId,
    kind: "deterministic",
    predicate: {
      sub_kind: "requires_edge",
      edge_type: "supports",
      target_node_type: "intent",
      when_node_type: ["action", "decision", "state"],
    },
    on_violation: "block",
    fires_when_node_lifecycle: ["drafting", "queued", "active"],
  };
  await db.query(
    `INSERT INTO policies (id, doco_id, kind, data, lifecycle)
       VALUES ($1, $2, 'deterministic', $3::jsonb, 'active')`,
    [id, docoId, JSON.stringify(data)],
  );
}

/** Seed an arbitrary deterministic policy (NOT the serves floor). */
async function seedOtherPolicy(docoId: string): Promise<void> {
  await ensureDoco(docoId);
  const id = `policy_other_${Math.random().toString(36).slice(2)}`;
  const data = {
    id,
    doco_id: docoId,
    kind: "deterministic",
    predicate: {
      sub_kind: "requires_node_type",
      node_types: ["intent", "action", "decision"],
    },
    on_violation: "block",
  };
  await db.query(
    `INSERT INTO policies (id, doco_id, kind, data, lifecycle)
       VALUES ($1, $2, 'deterministic', $3::jsonb, 'active')`,
    [id, docoId, JSON.stringify(data)],
  );
}

interface CeilingRow {
  id: string;
  on_violation: string | null;
  fires: string[] | null;
  predicate: Record<string, unknown>;
  template_seeded: boolean | null;
  template_handle: string | null;
}

async function ceilingRows(docoId: string): Promise<CeilingRow[]> {
  const r = await db.query<{ id: string; data: Record<string, unknown> }>(
    `SELECT id, data FROM policies
      WHERE doco_id = $1
        AND lifecycle = 'active'
        AND data -> 'predicate' ->> 'sub_kind' = 'limits_edge'
        AND data -> 'predicate' ->> 'edge_type' = 'supports'
        AND data -> 'predicate' ->> 'target_node_type' = 'intent'`,
    [docoId],
  );
  return r.rows.map((row) => {
    const data = (typeof row.data === "string" ? JSON.parse(row.data) : row.data) as Record<
      string,
      unknown
    >;
    return {
      id: row.id,
      on_violation: (data.on_violation as string) ?? null,
      fires: (data.fires_when_node_lifecycle as string[]) ?? null,
      predicate: data.predicate as Record<string, unknown>,
      template_seeded: (data.template_seeded as boolean) ?? null,
      template_handle: (data.template_handle as string) ?? null,
    };
  });
}

describe("business-processes serves-ceiling policy migration", () => {
  beforeEach(async () => {
    db = new PGlite();
    await db.exec(schemaSql); // fresh baseline (migration is a no-op on an empty DB)
  });

  it("inserts the serves ceiling into a business-processes Doco that lacks it", async () => {
    await seedServesFloor("doco_bp");
    await db.exec(schemaSql); // re-apply baseline — what every boot does

    const rows = await ceilingRows("doco_bp");
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.id.startsWith("policy_")).toBe(true);
    expect(row?.on_violation).toBe("block");
    expect(row?.fires).toEqual(["drafting", "queued", "active"]);
    expect(row?.template_seeded).toBe(true);
    expect(row?.template_handle).toBe("business-processes");
    expect(row?.predicate).toMatchObject({
      sub_kind: "limits_edge",
      edge_type: "supports",
      target_node_type: "intent",
      max_count: 1,
      when_node_type: ["action", "decision", "state"],
    });
    // Edge `role` is gone — the inserted ceiling carries no role tag.
    expect(row?.predicate.edge_role).toBeUndefined();
  });

  it("is idempotent — a second boot does not add a duplicate", async () => {
    await seedServesFloor("doco_bp");
    await db.exec(schemaSql);
    expect(await ceilingRows("doco_bp")).toHaveLength(1);
    await db.exec(schemaSql);
    expect(await ceilingRows("doco_bp")).toHaveLength(1);
  });

  it("leaves a Doco without the serves floor untouched (not a business-processes Doco)", async () => {
    await seedOtherPolicy("doco_other");
    await db.exec(schemaSql);
    expect(await ceilingRows("doco_other")).toHaveLength(0);
  });

  it("does not add a second ceiling when one already exists (under any id)", async () => {
    await seedServesFloor("doco_bp");
    // Simulate a freshly template-seeded Doco: the ceiling already present under
    // a ULID-shaped id. The migration must match on the predicate fingerprint,
    // not the derived id, and skip it.
    const existingId = "policy_01EXISTINGCEILING0000000001";
    const data = {
      id: existingId,
      doco_id: "doco_bp",
      kind: "deterministic",
      predicate: {
        sub_kind: "limits_edge",
        edge_type: "supports",
        target_node_type: "intent",
        max_count: 1,
        when_node_type: ["action", "decision", "state"],
      },
      on_violation: "block",
      fires_when_node_lifecycle: ["drafting", "queued", "active"],
    };
    await db.query(
      `INSERT INTO policies (id, doco_id, kind, data, lifecycle)
         VALUES ($1, 'doco_bp', 'deterministic', $2::jsonb, 'active')`,
      [existingId, JSON.stringify(data)],
    );

    await db.exec(schemaSql);
    const rows = await ceilingRows("doco_bp");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(existingId);
  });

  it("migrates many business-processes Docos in one boot", async () => {
    await seedServesFloor("doco_bp1");
    await seedServesFloor("doco_bp2");
    await seedOtherPolicy("doco_plain");
    await db.exec(schemaSql);
    expect(await ceilingRows("doco_bp1")).toHaveLength(1);
    expect(await ceilingRows("doco_bp2")).toHaveLength(1);
    expect(await ceilingRows("doco_plain")).toHaveLength(0);
  });
});
