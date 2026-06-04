// The business-processes Intent-shape policy used to demand that the Intent
// body spell out the trigger, the terminal outcome, and what is out of scope.
// That forced verbose Intents — the prose restated facts the graph already
// holds (initial State, terminal State, flow wiring). The template now grades
// only the FIRST LINE as a brief BPMN name.
//
// Only `predicate.agent_instruction` is persisted on a seeded policy row (never
// the prose `policy`), so the fix for already-seeded Docos is a data migration:
// schema.sql is re-applied on every boot and rewrites any row still carrying
// the old "remaining text lets the reader discern" clause. This test seeds a
// Doco with the legacy policy row, re-applies the baseline (what every boot
// does), and asserts the spec is rewritten — and that the migration is
// idempotent and leaves unrelated policies untouched.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

const OLD_SPEC =
  "Check the Intent's `intent` field. PASS only when BOTH hold: (a) the FIRST LINE is a brief process name — a short verb + object phrase, optionally with an adjective or adverb, roughly two to six words (e.g. `Publish a job`), and NOT a full run-on sentence that buries the name; and (b) the remaining text lets the reader discern (1) the trigger that starts the process, (2) the terminal business outcome that ends it, and (3) what is explicitly out of scope. FAIL with what is wrong — say `first line is not a brief headline` when line one crams the whole description into one sentence, or name the missing trigger / outcome / out-of-scope element.";

let db: PGlite;

async function seedDocoAndPolicy(spec: string): Promise<string> {
  await db.exec(`
    INSERT INTO workspaces (id, handle, name, data)
      VALUES ('workspace_test', 'ws', 'WS', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO docos (id, handle, owner_id, workspace_id, data)
      VALUES ('doco_test', 'bp', 'workspace_test', 'workspace_test', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
  `);
  const id = `policy_${Math.random().toString(36).slice(2)}`;
  const data = {
    id,
    doco_id: "doco_test",
    kind: "probabilistic",
    predicate: { agent_instruction: spec, when_node_type: ["intent"] },
    on_violation: "block",
    fires_when_node_lifecycle: ["queued", "active"],
  };
  await db.query(
    `INSERT INTO policies (id, doco_id, kind, data, lifecycle)
       VALUES ($1, 'doco_test', 'probabilistic', $2::jsonb, 'active')`,
    [id, JSON.stringify(data)],
  );
  return id;
}

async function specOf(id: string): Promise<string> {
  const r = await db.query<{ spec: string }>(
    `SELECT data -> 'predicate' ->> 'agent_instruction' AS spec FROM policies WHERE id = $1`,
    [id],
  );
  return r.rows[0]?.spec ?? "";
}

describe("business-processes Intent-shape policy migration", () => {
  beforeEach(async () => {
    db = new PGlite();
    await db.exec(schemaSql); // fresh baseline
  });

  it("re-applying the baseline rewrites a legacy intent-shape spec to the headline-only clause", async () => {
    const id = await seedDocoAndPolicy(OLD_SPEC);

    // Re-apply the baseline — exactly what every boot does.
    await db.exec(schemaSql);

    const spec = await specOf(id);
    // The brief-headline clause survives…
    expect(spec).toMatch(/first line/i);
    expect(spec).toMatch(/brief|short/i);
    // …and the trigger / outcome / out-of-scope demand is gone.
    expect(spec).not.toMatch(/the remaining text lets the reader discern/i);
    expect(spec).not.toMatch(/trigger/i);
    expect(spec).not.toMatch(/terminal business outcome/i);
    expect(spec).not.toMatch(/out of scope|out-of-scope/i);
  });

  it("is idempotent — a second boot does not change the already-migrated row", async () => {
    const id = await seedDocoAndPolicy(OLD_SPEC);
    await db.exec(schemaSql);
    const once = await specOf(id);
    await db.exec(schemaSql);
    const twice = await specOf(id);
    expect(twice).toBe(once);
  });

  it("leaves unrelated probabilistic policies untouched", async () => {
    const other =
      "Check the Principal's `name` and `body_md`. PASS when it names a role, team, external party, or system.";
    const id = await seedDocoAndPolicy(other);
    await db.exec(schemaSql);
    expect(await specOf(id)).toBe(other);
  });
});
