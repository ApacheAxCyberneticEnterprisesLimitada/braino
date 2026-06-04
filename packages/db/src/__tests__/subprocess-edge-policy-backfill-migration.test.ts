// The business-processes template gained an EDGE-scoped probabilistic policy:
// when a calling Action supports a child purpose Intent (a sub-process), the
// Intent's name must be the base (imperative) form of the third-person Action
// (`Posts a job` -> `Post a job`). New Docos seed it at creation, but Docos
// created before the policy existed don't have it — so a data migration in
// schema.sql backfills every already-seeded business-processes Doco. This test
// seeds a Doco with the membership marker but no edge policy, re-applies the
// baseline (what every boot does), and asserts the edge policy is inserted —
// idempotently, scoped to business-process Docos, and without duplicating a Doco
// that already has it. Edge `role` is retired: the backfilled edge-probabilistic
// carries no `edge_role` — it is scoped by edge_type + endpoint node types.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

const MEMBERSHIP_SPEC =
  "A node belongs in business-processes when it describes a workflow — a sequence of steps with actors and an outcome — or a policy/guard for one.";

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

/** Seed a probabilistic policy carrying `spec` on a Doco. */
async function seedProbabilistic(docoId: string, spec: string): Promise<void> {
  await ensureDoco(docoId);
  const id = `policy_${Math.random().toString(36).slice(2)}`;
  const data = {
    id,
    doco_id: docoId,
    kind: "probabilistic",
    predicate: { agent_instruction: spec, when_node_type: ["intent"] },
    on_violation: "warn",
  };
  await db.query(
    `INSERT INTO policies (id, doco_id, kind, data, lifecycle)
       VALUES ($1, $2, 'probabilistic', $3::jsonb, 'active')`,
    [id, docoId, JSON.stringify(data)],
  );
}

interface EdgePolicyRow {
  id: string;
  edge_type: string | null;
  /** Edge `role` is gone — always null; asserted absent. */
  edge_role: string | null;
  from_node_type: string | null;
  to_node_type: string | null;
  on_violation: string | null;
  spec: string | null;
}

/** Every edge-scoped (probabilistic, has edge_type) policy on a Doco. */
async function edgePolicies(docoId: string): Promise<EdgePolicyRow[]> {
  const r = await db.query<EdgePolicyRow>(
    `SELECT id,
            data -> 'predicate' ->> 'edge_type'        AS edge_type,
            data -> 'predicate' ->> 'edge_role'        AS edge_role,
            data -> 'predicate' ->> 'from_node_type'   AS from_node_type,
            data -> 'predicate' ->> 'to_node_type'     AS to_node_type,
            data ->> 'on_violation'                    AS on_violation,
            data -> 'predicate' ->> 'agent_instruction' AS spec
       FROM policies
      WHERE doco_id = $1
        AND kind = 'probabilistic'
        AND data -> 'predicate' ? 'edge_type'
      ORDER BY id`,
    [docoId],
  );
  return r.rows;
}

describe("business-processes sub-process edge-policy backfill migration", () => {
  beforeEach(async () => {
    db = new PGlite();
    await db.exec(schemaSql); // fresh baseline
  });

  it("inserts the Action->Intent serves edge policy into a business-process Doco that lacks it", async () => {
    await seedProbabilistic("doco_bp", MEMBERSHIP_SPEC);
    expect(await edgePolicies("doco_bp")).toHaveLength(0);

    await db.exec(schemaSql); // re-apply baseline — what every boot does

    const edges = await edgePolicies("doco_bp");
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      edge_type: "supports",
      from_node_type: "action",
      to_node_type: "intent",
      on_violation: "block",
    });
    // No edge_role — the concept is gone, so the column comes back null.
    expect(edges[0].edge_role).toBeNull();
    expect(edges[0].spec).toMatch(/base \(imperative\) verb form/i);
    expect(edges[0].spec).toMatch(/Posts a job/);
    expect(edges[0].id.startsWith("policy_")).toBe(true);
  });

  it("is idempotent — a second boot does not insert a duplicate", async () => {
    await seedProbabilistic("doco_bp", MEMBERSHIP_SPEC);
    await db.exec(schemaSql);
    await db.exec(schemaSql);
    await db.exec(schemaSql);
    expect(await edgePolicies("doco_bp")).toHaveLength(1);
  });

  it("does NOT add the policy to a non-business-process Doco", async () => {
    // A glossary-style Doco: its membership marker is different.
    await seedProbabilistic(
      "doco_glo",
      "A node belongs in glossaries when it defines terminology.",
    );
    await db.exec(schemaSql);
    expect(await edgePolicies("doco_glo")).toHaveLength(0);
  });

  it("does not duplicate when the Doco already has the sub-process edge policy", async () => {
    await seedProbabilistic("doco_bp", MEMBERSHIP_SPEC);
    // Pre-seed an existing edge policy (as a freshly-created Doco would have).
    const id = `policy_${Math.random().toString(36).slice(2)}`;
    const data = {
      id,
      doco_id: "doco_bp",
      kind: "probabilistic",
      predicate: {
        agent_instruction: "pre-existing sub-process edge policy",
        edge_type: "supports",
        from_node_type: "action",
        to_node_type: "intent",
      },
      on_violation: "block",
    };
    await db.query(
      `INSERT INTO policies (id, doco_id, kind, data, lifecycle)
         VALUES ($1, 'doco_bp', 'probabilistic', $2::jsonb, 'active')`,
      [id, JSON.stringify(data)],
    );

    await db.exec(schemaSql);

    const edges = await edgePolicies("doco_bp");
    expect(edges).toHaveLength(1);
    expect(edges[0].id).toBe(id); // the original, untouched
  });

  it("backfills every business-process Doco, scoped correctly", async () => {
    await seedProbabilistic("doco_bp1", MEMBERSHIP_SPEC);
    await seedProbabilistic("doco_bp2", MEMBERSHIP_SPEC);
    await seedProbabilistic(
      "doco_other",
      "A node belongs in glossaries when it defines terminology.",
    );

    await db.exec(schemaSql);

    expect(await edgePolicies("doco_bp1")).toHaveLength(1);
    expect(await edgePolicies("doco_bp2")).toHaveLength(1);
    expect(await edgePolicies("doco_other")).toHaveLength(0);
  });
});
