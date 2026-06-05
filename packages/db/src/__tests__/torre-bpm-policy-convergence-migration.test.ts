// torre-bpm (doco_01KT7G5PCX4273VHWW8SAAVSJC) was seeded from the
// business-processes template BEFORE the "an edge's meaning comes from its type
// + endpoint node types, not a role tag" refactor. Its deterministic predicates
// were already converged by the edge `role` removal block, but its prose
// (suggestion / edge-probabilistic) policies still carried the old
// `serves` / `performed_by` / `owned_by` / "role metadata" wording, the
// "AT MOST one Intent pool" ceiling was left retired, and the
// "Name a sub-process by pairing…" guidance was never seeded.
//
// The schema.sql convergence block rewrites that one Doco's policies onto the
// current template text. This test seeds the stale shapes under that doco_id,
// re-applies the baseline (what every boot does), and asserts the convergence —
// idempotently, and scoped to that one Doco.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

const TORRE = "doco_01KT7G5PCX4273VHWW8SAAVSJC";
const GUIDANCE_ID = "policy_torrebpm_name_subprocess_guidance";

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

/** Insert a prose policy (suggestion or probabilistic) carrying a stale instruction. */
async function seedProse(
  docoId: string,
  id: string,
  kind: "suggestion" | "probabilistic",
  agentInstruction: string,
  extraPredicate: Record<string, unknown> = {},
): Promise<void> {
  await ensureDoco(docoId);
  const data = {
    id,
    doco_id: docoId,
    kind,
    predicate: { agent_instruction: agentInstruction, ...extraPredicate },
    lifecycle: "active",
  };
  await db.query(
    `INSERT INTO policies (id, doco_id, kind, data, lifecycle)
       VALUES ($1, $2, $3, $4::jsonb, 'active')`,
    [id, docoId, kind, JSON.stringify(data)],
  );
}

async function instructionOf(id: string): Promise<string | null> {
  const r = await db.query<{ ai: string | null }>(
    `SELECT data -> 'predicate' ->> 'agent_instruction' AS ai FROM policies WHERE id = $1`,
    [id],
  );
  return r.rows[0]?.ai ?? null;
}

/** Seed every stale shape the convergence block targets, under the given Doco. */
async function seedStale(docoId: string): Promise<void> {
  await seedProse(
    docoId,
    `${docoId}_judge`,
    "probabilistic",
    "You are checking a `serves` relationship from an Action to a purpose Intent. stale body.",
    { edge_type: "supports", from_node_type: "action", to_node_type: "intent" },
  );
  await seedProse(
    docoId,
    `${docoId}_whole`,
    "suggestion",
    "When a step is itself a whole sub-process, connect the calling Action with a `serves` relationship (stored as `supports` role `serves`) instead of inlining.",
  );
  await seedProse(
    docoId,
    `${docoId}_owner`,
    "suggestion",
    "Name the single accountable process owner and link it with an `attributed_to` edge carrying role `owned_by`, distinct from role `performed_by`.",
  );
  await seedProse(
    docoId,
    `${docoId}_agents`,
    "suggestion",
    "Agents should write changesets using the contract's role examples instead of ad hoc names.",
  );
  await seedProse(
    docoId,
    `${docoId}_vocab`,
    "suggestion",
    "BPMN vocabulary: `flows_to` is process order; `serves` (stored as `supports`) places nodes in pools.",
  );
  await seedProse(
    docoId,
    `${docoId}_rel`,
    "suggestion",
    "Use the canonical families (`supports`, `relates_to`) with role metadata for specialized meanings. Re-point by retiring the old edge.",
  );
  await seedProse(
    docoId,
    `${docoId}_queued`,
    "suggestion",
    "A `queued` node must already satisfy the same actor, `serves`, and forward-flow wiring an `active` node does.",
  );
  await seedProse(
    docoId,
    `${docoId}_walk`,
    "suggestion",
    "A `drafting` sketch may be incomplete, except that an Action must name its actor each via an `attributed_to` edge to a Principal, from the moment it is drafted, so neither floats free of a Principal even in draft.",
  );
  await seedProse(
    docoId,
    `${docoId}_bpm`,
    "suggestion",
    "PREAMBLE. Honor the lane for `performed_by`, but write the Action prose consistent with that lane's actor. TRAILING.",
  );

  // Retired ceiling — present but not in force.
  const ceiling = {
    id: `${docoId}_ceiling`,
    doco_id: docoId,
    kind: "deterministic",
    predicate: {
      sub_kind: "limits_edge",
      edge_type: "supports",
      target_node_type: "intent",
      max_count: 1,
      when_node_type: ["action", "decision", "state"],
    },
    on_violation: "block",
    lifecycle: "retired",
  };
  await db.query(
    `INSERT INTO policies (id, doco_id, kind, data, lifecycle)
       VALUES ($1, $2, 'deterministic', $3::jsonb, 'retired')`,
    [`${docoId}_ceiling`, docoId, JSON.stringify(ceiling)],
  );
}

describe("torre-bpm policy convergence migration", () => {
  beforeEach(async () => {
    db = new PGlite();
    await db.exec(schemaSql); // fresh baseline; the block no-ops on an empty DB
  });

  it("rewrites every stale prose policy onto the current role-free template text", async () => {
    await seedStale(TORRE);
    await db.exec(schemaSql); // re-apply baseline — what every boot does

    const judge = await instructionOf(`${TORRE}_judge`);
    expect(judge).toContain("You are checking a `supports` relationship from an Action");
    expect(judge).not.toContain("`serves`");

    const whole = await instructionOf(`${TORRE}_whole`);
    expect(whole).toContain("connect the calling Action to it with a `supports` edge");
    expect(whole).not.toContain("role `serves`");

    const owner = await instructionOf(`${TORRE}_owner`);
    expect(owner).toContain("`attributed_to` edge from the Intent to that Principal");
    expect(owner).not.toContain("carrying role `owned_by`");

    const agents = await instructionOf(`${TORRE}_agents`);
    expect(agents).toContain("contract's edge types");
    expect(agents).not.toContain("role examples");

    const vocab = await instructionOf(`${TORRE}_vocab`);
    expect(vocab).toContain(
      "BPMN vocabulary — an edge's meaning comes from its type plus the node types it connects",
    );
    expect(vocab).not.toContain("BPMN vocabulary: `flows_to`");

    const rel = await instructionOf(`${TORRE}_rel`);
    expect(rel).toContain("not from a role tag");
    expect(rel).not.toContain("with role metadata for specialized meanings");

    const queued = await instructionOf(`${TORRE}_queued`);
    expect(queued).toContain("same actor attribution, supporting Intent, and forward-flow wiring");
    expect(queued).not.toContain("actor, `serves`,");

    const walk = await instructionOf(`${TORRE}_walk`);
    expect(walk).toContain("are all suspended, so a step can be drafted before its actor");
    expect(walk).not.toContain("from the moment it is drafted, so neither floats free");
  });

  it("keeps the sub-process judge edge-scoped (only the instruction changes)", async () => {
    await seedStale(TORRE);
    await db.exec(schemaSql);
    const r = await db.query<{ predicate: Record<string, unknown> }>(
      `SELECT data -> 'predicate' AS predicate FROM policies WHERE id = $1`,
      [`${TORRE}_judge`],
    );
    expect(r.rows[0]?.predicate).toMatchObject({
      edge_type: "supports",
      from_node_type: "action",
      to_node_type: "intent",
    });
  });

  it("rewrites only the stale `performed_by` phrase in the BPM-import guide, leaving the rest intact", async () => {
    await seedStale(TORRE);
    await db.exec(schemaSql);
    const bpm = await instructionOf(`${TORRE}_bpm`);
    expect(bpm).toContain("Honor the lane as the Action's `attributed_to` edge to its Principal,");
    expect(bpm).not.toContain("Honor the lane for `performed_by`");
    expect(bpm?.startsWith("PREAMBLE.")).toBe(true);
    expect(bpm?.endsWith("TRAILING.")).toBe(true);
  });

  it("re-asserts the retired AT-MOST-one-Intent ceiling (column and data.lifecycle)", async () => {
    await seedStale(TORRE);
    await db.exec(schemaSql);
    const r = await db.query<{ lifecycle: string; data_life: string }>(
      `SELECT lifecycle, data ->> 'lifecycle' AS data_life
         FROM policies WHERE id = $1`,
      [`${TORRE}_ceiling`],
    );
    expect(r.rows[0]?.lifecycle).toBe("active");
    expect(r.rows[0]?.data_life).toBe("active");
  });

  it("backfills the missing 'Name a sub-process by pairing' guidance once", async () => {
    await seedStale(TORRE);
    await db.exec(schemaSql);
    const r = await db.query<{ kind: string; ai: string }>(
      `SELECT kind, data -> 'predicate' ->> 'agent_instruction' AS ai
         FROM policies WHERE id = $1 AND lifecycle = 'active'`,
      [GUIDANCE_ID],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.kind).toBe("suggestion");
    expect(r.rows[0]?.ai?.startsWith("Name a sub-process by pairing")).toBe(true);
  });

  it("is idempotent — a second boot changes nothing and adds no duplicate", async () => {
    await seedStale(TORRE);
    await db.exec(schemaSql);
    const after1 = await instructionOf(`${TORRE}_judge`);
    const count1 = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM policies WHERE doco_id = $1",
      [TORRE],
    );
    await db.exec(schemaSql); // boot again
    const after2 = await instructionOf(`${TORRE}_judge`);
    const count2 = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM policies WHERE doco_id = $1",
      [TORRE],
    );
    expect(after2).toBe(after1);
    expect(count2.rows[0]?.n).toBe(count1.rows[0]?.n);
    const guidance = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM policies WHERE id = $1",
      [GUIDANCE_ID],
    );
    expect(guidance.rows[0]?.n).toBe(1);
  });

  it("does not touch a different Doco that happens to carry the same stale text", async () => {
    const OTHER = "doco_other_bp";
    await seedStale(OTHER);
    await db.exec(schemaSql);
    // Scoped by doco_id: the other Doco's stale text is left as-is, and it gets
    // no backfilled guidance row.
    expect(await instructionOf(`${OTHER}_judge`)).toContain("`serves`");
    const guidance = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM policies WHERE doco_id = $1 AND id = $2",
      [OTHER, GUIDANCE_ID],
    );
    expect(guidance.rows[0]?.n).toBe(0);
  });
});
