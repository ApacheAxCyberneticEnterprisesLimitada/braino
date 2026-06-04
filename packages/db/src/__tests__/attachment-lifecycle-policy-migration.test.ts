// Already-seeded business-processes Docos got the three flow-node ATTACHMENT
// gates — a flow node `serves` an Intent, an Action is `performed_by` a
// Principal, a gateway Decision is `decided_by` a Principal — firing only on
// the committed stages (`["queued","active"]`). The template now fires them
// from `drafting` onward (BUSINESS_PROCESS_ATTACHED_LIFECYCLES), so no flow
// node floats free of an Intent or Principal even in a sketch — only the
// completeness/shape gates stay drafting-exempt.
//
// Only `predicate` + `fires_when_node_lifecycle` are persisted on a seeded
// policy row, so the fix for already-seeded Docos is a data migration in
// schema.sql, re-applied on every boot. This test seeds the legacy rows,
// re-applies the baseline (what every boot does), and asserts the three
// converge to include `drafting` — idempotently, and without touching unrelated
// policies (notably the actor-coverage `performed_by` nudge and the `owned_by`
// owner gate, which stay committed-only).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

let db: PGlite;

async function ensureDoco(): Promise<void> {
  await db.exec(`
    INSERT INTO workspaces (id, handle, name, data)
      VALUES ('workspace_test', 'ws', 'WS', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO docos (id, handle, owner_id, workspace_id, data)
      VALUES ('doco_test', 'bp', 'workspace_test', 'workspace_test', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
  `);
}

/** Seed a deterministic requires_edge_role policy with the given predicate shape. */
async function seedEdgeRole(opts: {
  edge_type: string;
  edge_role: string;
  when_node_type: string[];
  target_node_type?: string;
  direction?: string;
  fires?: string[];
}): Promise<string> {
  await ensureDoco();
  const id = `policy_${Math.random().toString(36).slice(2)}`;
  const predicate: Record<string, unknown> = {
    sub_kind: "requires_edge_role",
    edge_type: opts.edge_type,
    edge_role: opts.edge_role,
    when_node_type: opts.when_node_type,
    ...(opts.target_node_type ? { target_node_type: opts.target_node_type } : {}),
    ...(opts.direction ? { direction: opts.direction } : {}),
  };
  const data: Record<string, unknown> = {
    id,
    doco_id: "doco_test",
    kind: "deterministic",
    predicate,
    on_violation: "block",
    ...(opts.fires ? { fires_when_node_lifecycle: opts.fires } : {}),
  };
  await db.query(
    `INSERT INTO policies (id, doco_id, kind, data, lifecycle)
       VALUES ($1, 'doco_test', 'deterministic', $2::jsonb, 'active')`,
    [id, JSON.stringify(data)],
  );
  return id;
}

async function firesOf(id: string): Promise<string[] | null> {
  const r = await db.query<{ f: string | null }>(
    `SELECT data ->> 'fires_when_node_lifecycle' AS f FROM policies WHERE id = $1`,
    [id],
  );
  const raw = r.rows[0]?.f ?? null;
  return raw == null ? null : (JSON.parse(raw) as string[]);
}

// The three attachment gates, as the template seeds them today.
const SERVES = {
  edge_type: "supports",
  edge_role: "serves",
  target_node_type: "intent",
  when_node_type: ["action", "decision", "state"],
} as const;
const PERFORMED_BY = {
  edge_type: "attributed_to",
  edge_role: "performed_by",
  target_node_type: "principal",
  when_node_type: ["action"],
} as const;
const DECIDED_BY = {
  edge_type: "attributed_to",
  edge_role: "decided_by",
  target_node_type: "principal",
  when_node_type: ["decision"],
} as const;

describe("business-processes attachment-gate lifecycle migration", () => {
  beforeEach(async () => {
    db = new PGlite();
    await db.exec(schemaSql); // fresh baseline
  });

  it("adds `drafting` to the serves-Intent gate (was committed-only)", async () => {
    const id = await seedEdgeRole({ ...SERVES, fires: ["queued", "active"] });
    await db.exec(schemaSql); // re-apply baseline — what every boot does
    expect(await firesOf(id)).toEqual(["drafting", "queued", "active"]);
  });

  it("adds `drafting` to the Action performed_by gate", async () => {
    const id = await seedEdgeRole({ ...PERFORMED_BY, fires: ["queued", "active"] });
    await db.exec(schemaSql);
    expect(await firesOf(id)).toEqual(["drafting", "queued", "active"]);
  });

  it("adds `drafting` to the gateway decided_by gate", async () => {
    const id = await seedEdgeRole({ ...DECIDED_BY, fires: ["queued", "active"] });
    await db.exec(schemaSql);
    expect(await firesOf(id)).toEqual(["drafting", "queued", "active"]);
  });

  it("is idempotent — a second boot does not change an already-migrated row", async () => {
    const id = await seedEdgeRole({ ...SERVES, fires: ["queued", "active"] });
    await db.exec(schemaSql);
    const once = await firesOf(id);
    await db.exec(schemaSql);
    expect(await firesOf(id)).toEqual(once);
  });

  it("leaves the actor-coverage performed_by nudge committed-only (no target_node_type, incoming)", async () => {
    // This `performed_by` gate fires on the Principal and carries no
    // target_node_type and an `incoming` direction — it is a quality nudge, not
    // an attachment gate, so the migration must NOT widen it to drafting.
    const id = await seedEdgeRole({
      edge_type: "attributed_to",
      edge_role: "performed_by",
      when_node_type: ["principal"],
      direction: "incoming",
      fires: ["queued", "active"],
    });
    await db.exec(schemaSql);
    expect(await firesOf(id)).toEqual(["queued", "active"]);
  });

  it("leaves the owned_by owner gate committed-only", async () => {
    const id = await seedEdgeRole({
      edge_type: "attributed_to",
      edge_role: "owned_by",
      target_node_type: "principal",
      when_node_type: ["intent"],
      fires: ["queued", "active"],
    });
    await db.exec(schemaSql);
    expect(await firesOf(id)).toEqual(["queued", "active"]);
  });

  it("leaves the Eval tests gate committed-only (no target, role tests)", async () => {
    const id = await seedEdgeRole({
      edge_type: "supports",
      edge_role: "tests",
      when_node_type: ["eval"],
      fires: ["queued", "active"],
    });
    await db.exec(schemaSql);
    expect(await firesOf(id)).toEqual(["queued", "active"]);
  });

  it("does not touch a retired attachment-gate row", async () => {
    const id = await seedEdgeRole({ ...SERVES, fires: ["queued", "active"] });
    await db.query("UPDATE policies SET lifecycle = 'retired' WHERE id = $1", [id]);
    await db.exec(schemaSql);
    expect(await firesOf(id)).toEqual(["queued", "active"]);
  });
});
