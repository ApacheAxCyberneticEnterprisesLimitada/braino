// The business-processes Intent-shape check used to be line-scoped: it graded
// "the first line" of the `intent` field (and, earlier still, also demanded the
// body spell out trigger/outcome/out-of-scope). Line-shaped grading distorts a
// field's vector embedding, so the check now reads the WHOLE field for a
// concise process purpose, and the deterministic `field-line-shape` floor is
// retired outright.
//
// Only `predicate.agent_instruction` is persisted on a seeded policy row (never
// the prose `policy`), so the fix for already-seeded Docos is a data migration
// in schema.sql, re-applied on every boot. This test seeds a Doco with the
// legacy rows in EITHER prior state, re-applies the baseline (what every boot
// does), and asserts the rows converge — idempotently, and without touching
// unrelated policies.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

// The original (PR #991-and-earlier) two-clause spec demanding trigger/outcome/scope.
const TWO_CLAUSE_SPEC =
  "Check the Intent's `intent` field. PASS only when BOTH hold: (a) the FIRST LINE is a brief process name — a short verb + object phrase, optionally with an adjective or adverb, roughly two to six words (e.g. `Publish a job`), and NOT a full run-on sentence that buries the name; and (b) the remaining text lets the reader discern (1) the trigger that starts the process, (2) the terminal business outcome that ends it, and (3) what is explicitly out of scope.";

// The interim first-line-only spec (post PR #991, pre this change).
const FIRST_LINE_SPEC =
  "Check the FIRST LINE of the Intent's `intent` field. PASS when the first line is a brief process name — a short verb + object phrase, roughly two to six words. Judge ONLY the first line; whatever follows it is free prose and is not graded.";

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

async function seedProbabilistic(spec: string): Promise<string> {
  await ensureDoco();
  const id = `policy_${Math.random().toString(36).slice(2)}`;
  const data = {
    id,
    doco_id: "doco_test",
    kind: "probabilistic",
    predicate: { agent_instruction: spec, when_node_type: ["intent"] },
    on_violation: "block",
  };
  await db.query(
    `INSERT INTO policies (id, doco_id, kind, data, lifecycle)
       VALUES ($1, 'doco_test', 'probabilistic', $2::jsonb, 'active')`,
    [id, JSON.stringify(data)],
  );
  return id;
}

async function seedDeterministic(subKind: string): Promise<string> {
  await ensureDoco();
  const id = `policy_${Math.random().toString(36).slice(2)}`;
  const data = {
    id,
    doco_id: "doco_test",
    kind: "deterministic",
    predicate: { sub_kind: subKind, field: "intent", max_first_line_chars: 80 },
    on_violation: "warn",
  };
  await db.query(
    `INSERT INTO policies (id, doco_id, kind, data, lifecycle)
       VALUES ($1, 'doco_test', 'deterministic', $2::jsonb, 'active')`,
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

async function lifecycleOf(id: string): Promise<string> {
  const r = await db.query<{ lifecycle: string }>("SELECT lifecycle FROM policies WHERE id = $1", [
    id,
  ]);
  return r.rows[0]?.lifecycle ?? "";
}

function expectWholeFieldSpec(spec: string): void {
  // Whole-field grading, concise process purpose…
  expect(spec).toMatch(/entire|whole field/i);
  expect(spec).toMatch(/repeatable business process/i);
  expect(spec).toMatch(/concise/i);
  // …and emphatically NOT line-scoped, and no trigger/outcome/scope demand.
  expect(spec).not.toMatch(/first line/i);
  expect(spec).not.toMatch(/the remaining text lets the reader discern/i);
  expect(spec).not.toMatch(/trigger/i);
  expect(spec).not.toMatch(/out of scope|out-of-scope/i);
}

describe("business-processes Intent-shape policy migration", () => {
  beforeEach(async () => {
    db = new PGlite();
    await db.exec(schemaSql); // fresh baseline
  });

  it("converges the original two-clause spec to the whole-field judge", async () => {
    const id = await seedProbabilistic(TWO_CLAUSE_SPEC);
    await db.exec(schemaSql); // re-apply baseline — what every boot does
    expectWholeFieldSpec(await specOf(id));
  });

  it("converges the interim first-line spec to the whole-field judge", async () => {
    const id = await seedProbabilistic(FIRST_LINE_SPEC);
    await db.exec(schemaSql);
    expectWholeFieldSpec(await specOf(id));
  });

  it("is idempotent — a second boot does not change the already-migrated row", async () => {
    const id = await seedProbabilistic(TWO_CLAUSE_SPEC);
    await db.exec(schemaSql);
    const once = await specOf(id);
    await db.exec(schemaSql);
    expect(await specOf(id)).toBe(once);
  });

  it("retires the deterministic field-line-shape floor", async () => {
    const id = await seedDeterministic("field-line-shape");
    await db.exec(schemaSql);
    expect(await lifecycleOf(id)).toBe("retired");
    // Idempotent: a second boot leaves it retired.
    await db.exec(schemaSql);
    expect(await lifecycleOf(id)).toBe("retired");
  });

  it("leaves unrelated probabilistic policies untouched", async () => {
    const other =
      "Check the Decision. PASS when it records a clear, single choice with its rationale.";
    const id = await seedProbabilistic(other);
    // Make it a non-intent policy so the when_node_type guard also excludes it.
    await db.query(
      `UPDATE policies SET data = jsonb_set(data, '{predicate,when_node_type}', '["principal"]'::jsonb) WHERE id = $1`,
      [id],
    );
    await db.exec(schemaSql);
    expect(await specOf(id)).toBe(other);
  });

  it("leaves unrelated deterministic policies active", async () => {
    const id = await seedDeterministic("requires_node_type");
    await db.exec(schemaSql);
    expect(await lifecycleOf(id)).toBe("active");
  });
});
