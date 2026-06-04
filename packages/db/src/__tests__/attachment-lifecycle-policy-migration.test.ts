// Boot-time UPDATEs in schema.sql used to force `fires_when_node_lifecycle` on
// the three business-process flow-node attachment gates — a flow node serves an
// Intent (`supports` → intent), an Action names its performer and a gateway
// Decision its decider (`attributed_to` → principal). They were one-time
// convergence for already-seeded Docos, but schema.sql re-applies on EVERY
// boot, and their `? 'drafting'` guards re-matched the moment an owner edited a
// gate's lifecycle stages — so the next cold-start silently reverted the edit
// and the change "wouldn't save".
//
// Those re-applied UPDATEs have been removed. This test is the regression guard:
// an owner-customized attachment gate must SURVIVE a re-boot unchanged, in any
// direction (drafting removed, drafting added, narrowed to active-only). New
// Docos still get the right stages from the template at seed time (host.ts), so
// nothing relies on the boot-time heal anymore.
//
// Edge `role` is retired: these gates are role-free `requires_edge` predicates
// now (the meaning rides on edge_type + target_node_type + when_node_type). The
// role-removal migration only rewrites legacy `requires_edge_role` rows and
// touches only the `predicate`, never `fires_when_node_lifecycle`, so an owner's
// lifecycle edit on an already-role-free gate is untouched across a reboot.
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

/** Seed a deterministic role-free requires_edge policy with the given predicate shape. */
async function seedEdge(opts: {
  edge_type: string;
  when_node_type: string[];
  target_node_type?: string;
  direction?: string;
  fires?: string[];
}): Promise<string> {
  await ensureDoco();
  const id = `policy_${Math.random().toString(36).slice(2)}`;
  const predicate: Record<string, unknown> = {
    sub_kind: "requires_edge",
    edge_type: opts.edge_type,
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

// The three attachment gates, as the template seeds them today (role-free).
// The performer + decider gates are both `requires_edge`(attributed_to →
// principal), distinguished only by their candidate node type (`when_node_type`).
const SERVES = {
  edge_type: "supports",
  target_node_type: "intent",
  when_node_type: ["action", "decision", "state"],
} as const;
const PERFORMED_BY = {
  edge_type: "attributed_to",
  target_node_type: "principal",
  when_node_type: ["action"],
} as const;
const DECIDED_BY = {
  edge_type: "attributed_to",
  target_node_type: "principal",
  when_node_type: ["decision"],
} as const;

describe("business-processes attachment-gate lifecycle: owner edits survive a re-boot", () => {
  beforeEach(async () => {
    db = new PGlite();
    await db.exec(schemaSql); // fresh baseline
  });

  // The reported bug: an owner removes `drafting`, it saves, and the next boot
  // re-adds it. Each gate must now keep exactly what the owner set, either way.

  it("does NOT re-add `drafting` to the Action performed_by gate after an owner removes it", async () => {
    const id = await seedEdge({ ...PERFORMED_BY, fires: ["queued", "active"] });
    await db.exec(schemaSql); // re-apply baseline — what every boot does
    expect(await firesOf(id)).toEqual(["queued", "active"]);
  });

  it("does NOT re-add `drafting` to the gateway decided_by gate after an owner removes it", async () => {
    const id = await seedEdge({ ...DECIDED_BY, fires: ["queued", "active"] });
    await db.exec(schemaSql);
    expect(await firesOf(id)).toEqual(["queued", "active"]);
  });

  it("does NOT strip `drafting` from the serves-Intent gate after an owner adds it", async () => {
    const id = await seedEdge({ ...SERVES, fires: ["drafting", "queued", "active"] });
    await db.exec(schemaSql);
    expect(await firesOf(id)).toEqual(["drafting", "queued", "active"]);
  });

  it("leaves a serves-Intent gate the owner kept committed-only untouched", async () => {
    const id = await seedEdge({ ...SERVES, fires: ["queued", "active"] });
    await db.exec(schemaSql);
    expect(await firesOf(id)).toEqual(["queued", "active"]);
  });

  it("leaves an owner's narrower customization (active-only) untouched on every gate", async () => {
    const serves = await seedEdge({ ...SERVES, fires: ["active"] });
    const performed = await seedEdge({ ...PERFORMED_BY, fires: ["active"] });
    const decided = await seedEdge({ ...DECIDED_BY, fires: ["active"] });
    await db.exec(schemaSql);
    expect(await firesOf(serves)).toEqual(["active"]);
    expect(await firesOf(performed)).toEqual(["active"]);
    expect(await firesOf(decided)).toEqual(["active"]);
  });
});
