// PR #1005 revised the business-processes "lifecycle walk" guidance prose to
// say that a `drafting` sketch, while exempt from completeness/shape rules,
// must already be ATTACHED to its Intent/Principal. The deterministic gate
// migration (attachment-lifecycle-policy-migration) flipped the enforcement on
// already-seeded Docos, but that advisory `suggestion` row kept its OLD prose
// ("Sketch it in `drafting`… completeness and shape rules are suspended"). Only
// `predicate.agent_instruction` is persisted, so refreshing it for seeded Docos
// is a data migration in schema.sql, re-applied on every boot. This test seeds
// the legacy prose, re-applies the baseline, and asserts it converges to the
// new wording — idempotently, without touching unrelated suggestions.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, schemaSql } from "./fresh-db.js";

// The pre-#1005 lifecycle-walk prose, as the earliest-seeded Docos carry it.
const OLD_PROSE =
  "Walk a process node through the four-stage lifecycle drafting → queued → active → retired. Sketch it in `drafting`, where it may be incomplete — completeness and shape rules are suspended. `queue` it (changeset op `queue`) once its actor (`performed_by`, or `decided_by` for a gateway Decision), Intent (`serves`), and forward `flows_to` wiring are coherent and the design is ready; `activate` it (op `activate`) when it is the governing, in-force process. Both committed stages — `queued` and `active` — are held to the full shape rules; only a `drafting` sketch is exempt. `retire` a node when it is withdrawn, or `supersede` it when a redesign replaces it (the op creates the replacement and links the two with a `replaces` edge).";

// The interim (#1014) wording — when serving an Intent was ALSO required in
// drafting. Docos migrated during that window carry this; the migration must
// converge it too (proving the `<>`-not-substring idempotency guard).
const INTERIM_PROSE =
  "Walk a process node through the four-stage lifecycle drafting → queued → active → retired. A `drafting` sketch may be incomplete — completeness and shape rules (forward `flows_to` wiring, gateway exhaustiveness, milestone naming, quality) are suspended — but it must already be ATTACHED: a flow node `serves` its Intent from the moment it is drafted, an Action is `performed_by` a Principal, and a gateway Decision is `decided_by` one, so no node ever floats free of an Intent or Principal even in draft. Create the node and its `serves`/`performed_by`/`decided_by` edge together in one changeset. `queue` it (changeset op `queue`) once its forward `flows_to` wiring is coherent and the design is ready; `activate` it (op `activate`) when it is the governing, in-force process. Both committed stages — `queued` and `active` — are held to the full shape rules; a `drafting` sketch is exempt only from those completeness/shape rules, not from attachment. `retire` a node when it is withdrawn, or `supersede` it when a redesign replaces it (the op creates the replacement and links the two with a `replaces` edge).";

// The current prose: intent (serves) is deferrable in drafting; only the
// Principal actor/decider is required there. Edge `role` is retired, so the
// actor/decider attachment is described by the edge TYPE + endpoints (an
// `attributed_to` edge to a Principal), not a `performed_by`/`decided_by` role.
// Must stay byte-identical to the template in packages/host/src/doco-templates.ts
// so seeded + new Docos converge.
const NEW_PROSE =
  "Walk a process node through the four-stage lifecycle drafting → queued → active → retired. A `drafting` sketch may be incomplete — serving an Intent, forward `flows_to` wiring, gateway exhaustiveness, milestone naming, and quality are all suspended, so a step can be drafted before its Intent (and BPMN pool) is chosen — except that an Action must still name its actor and a gateway Decision its decider, each via an `attributed_to` edge to a Principal, from the moment it is drafted, so neither floats free of a Principal even in draft. `queue` it (changeset op `queue`) once it supports its Intent and its forward `flows_to` wiring is coherent and the design is ready; `activate` it (op `activate`) when it is the governing, in-force process. Both committed stages — `queued` and `active` — are held to the full shape rules. `retire` a node when it is withdrawn, or `supersede` it when a redesign replaces it (the op creates the replacement and links the two with a `replaces` edge).";

let db: PGlite;

async function ensureDoco(): Promise<void> {
  await db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('workspace_test', 'ws', 'WS')
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO docos (id, handle, owner_id, workspace_id, data)
      VALUES ('doco_test', 'bp', 'workspace_test', 'workspace_test', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
  `);
}

async function seedSuggestion(prose: string): Promise<string> {
  await ensureDoco();
  const id = `policy_${Math.random().toString(36).slice(2)}`;
  const data = {
    id,
    doco_id: "doco_test",
    kind: "suggestion",
    predicate: { agent_instruction: prose },
  };
  await db.query(
    `INSERT INTO policies (id, doco_id, kind, data, lifecycle)
       VALUES ($1, 'doco_test', 'suggestion', $2::jsonb, 'active')`,
    [id, JSON.stringify(data)],
  );
  return id;
}

async function proseOf(id: string): Promise<string> {
  const r = await db.query<{ p: string }>(
    `SELECT data -> 'predicate' ->> 'agent_instruction' AS p FROM policies WHERE id = $1`,
    [id],
  );
  return r.rows[0]?.p ?? "";
}

describe("business-processes lifecycle-walk suggestion prose migration", () => {
  beforeEach(async () => {
    db = await freshDb();
  });

  it("converges the earliest (pre-#1005) lifecycle-walk prose to the current wording", async () => {
    const id = await seedSuggestion(OLD_PROSE);
    await db.exec(schemaSql); // re-apply baseline — what every boot does
    expect(await proseOf(id)).toBe(NEW_PROSE);
  });

  it("converges the interim (#1014) prose to the current wording too", async () => {
    // The `<>` guard converges ANY earlier wording, not just one substring-keyed
    // version — so a Doco migrated during the intent-required-in-drafting window
    // lands on the current prose.
    const id = await seedSuggestion(INTERIM_PROSE);
    await db.exec(schemaSql);
    expect(await proseOf(id)).toBe(NEW_PROSE);
  });

  it("is idempotent — a second boot does not change the already-converged row", async () => {
    const id = await seedSuggestion(OLD_PROSE);
    await db.exec(schemaSql);
    const once = await proseOf(id);
    await db.exec(schemaSql);
    expect(await proseOf(id)).toBe(once);
    expect(await proseOf(id)).toBe(NEW_PROSE);
  });

  it("does not double-apply to a Doco already seeded with the new prose", async () => {
    const id = await seedSuggestion(NEW_PROSE);
    await db.exec(schemaSql);
    expect(await proseOf(id)).toBe(NEW_PROSE);
  });

  it("leaves an unrelated suggestion untouched", async () => {
    const other =
      "Use `queued` for a process — or a single step, gateway, or milestone — that is fully wired and ready but not yet in force.";
    const id = await seedSuggestion(other);
    await db.exec(schemaSql);
    expect(await proseOf(id)).toBe(other);
  });
});
