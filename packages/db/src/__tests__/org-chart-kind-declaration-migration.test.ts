// The org-chart Principal slim-down moved the person/agent declaration from
// `body_md` prose onto the structured `kind` field ("human" | "agent"); a vacant
// seat still carries no `kind` and declares its vacancy in prose. The template
// now seeds a kind-keyed probabilistic judge (and guidance prose that names
// `kind`), but every ALREADY-seeded org-chart Doco still carries the OLD
// body_md-only judge + prose. Only `predicate.agent_instruction` is persisted on
// a seeded policy row, so converging existing Docos is a data migration in
// schema.sql, re-applied on every boot.
//
// This test seeds an org-chart Doco with the legacy rows, re-applies the
// baseline (what every boot does), and asserts the rows converge to the
// kind-keyed wording — idempotently, scoped to org-chart Docos, and without
// touching unrelated policies or the deterministic body_md floor.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

// The pre-slim-down probabilistic declaration judge — body_md only.
const OLD_JUDGE_SPEC =
  "Read the Principal's `body_md`. PASS if the prose clearly states the seat is filled by a human person (e.g. 'Human director of …', 'Person responsible for …'), filled by an AI agent (e.g. 'AI agent operated by @alice', 'Autonomous research bot'), OR currently vacant/open (e.g. 'Vacant — budgeted Staff Engineer seat, reporting to …'). FAIL with a reason if `body_md` is empty or doesn't take a stance on person / AI agent / vacant.";

// The OLD guidance prose that pointed authors at body_md for the declaration.
const OLD_PERSON_VS_AGENT =
  "Person vs agent isn't about who signed in — it's about who fills the seat. A Principal whose `body_md` describes an AI agent (a code reviewer, a triage bot, a research agent) is an agent regardless of whether any User has signed in as it. A Principal whose `body_md` describes a human is a person, even if that human has no Doco account.";
const OLD_SEAT_VACANT =
  "Treat each Principal as a seat — a role plus its current occupant — not just a person. A budgeted-but-unfilled seat is a valid Principal: declare it `vacant` in `body_md`, name the role it's budgeted for, and keep its reporting edge so the tree stays complete. Omitting open roles hides headcount and distorts the reporting structure.";
const OLD_TURNOVER =
  "Seats persist across routine turnover: when one person leaves and another fills the same seat — or a seat goes vacant and is later refilled by the same kind of occupant — keep the Principal, update `body_md`, and record the change as a Decision, so reporting and membership edges stay intact and the seat's history reads continuously. Only when the seat's nature flips between person and AI agent do you retire the old Principal and create a new one.";

let db: PGlite;

async function ensureOrgChartDoco(
  handle = "doco_org",
  templateHandle = "org-chart",
): Promise<void> {
  await db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('workspace_test', 'ws', 'WS')
      ON CONFLICT (id) DO NOTHING;
  `);
  await db.query(
    `INSERT INTO docos (id, handle, owner_id, workspace_id, data)
       VALUES ($1, $1, 'workspace_test', 'workspace_test', $2::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    [handle, JSON.stringify({ template_handle: templateHandle })],
  );
}

async function seedProbabilistic(spec: string, docoId = "doco_org"): Promise<string> {
  const id = `policy_${Math.random().toString(36).slice(2)}`;
  const data = {
    id,
    doco_id: docoId,
    kind: "probabilistic",
    predicate: { agent_instruction: spec, when_node_type: ["principal"] },
    on_violation: "block",
    template_seeded: true,
    template_handle: "org-chart",
  };
  await db.query(
    `INSERT INTO policies (id, doco_id, kind, data, lifecycle)
       VALUES ($1, $2, 'probabilistic', $3::jsonb, 'active')`,
    [id, docoId, JSON.stringify(data)],
  );
  return id;
}

async function seedSuggestion(prose: string, docoId = "doco_org"): Promise<string> {
  const id = `policy_${Math.random().toString(36).slice(2)}`;
  const data = {
    id,
    doco_id: docoId,
    kind: "suggestion",
    predicate: { agent_instruction: prose },
    template_seeded: true,
    template_handle: "org-chart",
  };
  await db.query(
    `INSERT INTO policies (id, doco_id, kind, data, lifecycle)
       VALUES ($1, $2, 'suggestion', $3::jsonb, 'active')`,
    [id, docoId, JSON.stringify(data)],
  );
  return id;
}

async function seedBodyMdFloor(docoId = "doco_org"): Promise<string> {
  const id = `policy_${Math.random().toString(36).slice(2)}`;
  const data = {
    id,
    doco_id: docoId,
    kind: "deterministic",
    predicate: { sub_kind: "requires_field", fields: ["body_md"], when_node_type: ["principal"] },
    on_violation: "block",
    template_seeded: true,
    template_handle: "org-chart",
  };
  await db.query(
    `INSERT INTO policies (id, doco_id, kind, data, lifecycle)
       VALUES ($1, $2, 'deterministic', $3::jsonb, 'active')`,
    [id, docoId, JSON.stringify(data)],
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

async function predicateOf(id: string): Promise<Record<string, unknown>> {
  const r = await db.query<{ predicate: Record<string, unknown> }>(
    `SELECT data -> 'predicate' AS predicate FROM policies WHERE id = $1`,
    [id],
  );
  return r.rows[0]?.predicate ?? {};
}

describe("org-chart kind-declaration policy migration", () => {
  beforeEach(async () => {
    db = new PGlite();
    await db.exec(schemaSql); // fresh baseline
    await ensureOrgChartDoco();
  });

  it("rewrites the probabilistic declaration judge to key off `kind`", async () => {
    const id = await seedProbabilistic(OLD_JUDGE_SPEC);
    await db.exec(schemaSql); // re-apply baseline — what every boot does
    const spec = await specOf(id);
    // Keys off the structured `kind` field…
    expect(spec).toMatch(/Read the Principal's `kind` field/);
    expect(spec).toMatch(/`kind` is `human`/);
    expect(spec).toMatch(/`agent`/);
    // …and still recognises a vacant seat from prose (it carries no `kind`).
    expect(spec).toMatch(/vacant/i);
    expect(spec).toMatch(/`body_md`/);
    // The old body_md-only opening is gone.
    expect(spec).not.toMatch(/^Read the Principal's `body_md`\./);
  });

  it("is idempotent — a second boot does not change the already-migrated judge", async () => {
    const id = await seedProbabilistic(OLD_JUDGE_SPEC);
    await db.exec(schemaSql);
    const once = await specOf(id);
    await db.exec(schemaSql);
    expect(await specOf(id)).toBe(once);
  });

  it("does not double-apply when the Doco already carries the new kind-keyed spec", async () => {
    // Simulate a freshly-seeded Doco (new text already present).
    const NEW =
      "Read the Principal's `kind` field and its `body_md` prose. PASS if `kind` is `human` (the seat is filled by a person) or `agent` (filled by an AI agent), OR if `kind` is unset AND the `body_md` prose states the seat is currently vacant/open (e.g. 'Vacant — budgeted Staff Engineer seat, reporting to …'). FAIL with a reason if `kind` is unset AND the prose does not declare the seat vacant — the seat must state whether it's filled by a person, filled by an AI agent, or vacant.";
    const id = await seedProbabilistic(NEW);
    await db.exec(schemaSql);
    expect(await specOf(id)).toBe(NEW);
  });

  it("converges the three guidance suggestion prose rows to name the `kind` field", async () => {
    const pva = await seedSuggestion(OLD_PERSON_VS_AGENT);
    const seat = await seedSuggestion(OLD_SEAT_VACANT);
    const turn = await seedSuggestion(OLD_TURNOVER);
    await db.exec(schemaSql);

    const pvaSpec = await specOf(pva);
    expect(pvaSpec).toMatch(/declared in the `kind` field/);
    expect(pvaSpec).toMatch(/`kind: agent`/);
    expect(pvaSpec).toMatch(/`kind: human`/);

    const seatSpec = await specOf(seat);
    expect(seatSpec).toMatch(/A filled seat sets `kind`/);
    expect(seatSpec).toMatch(/leave `kind` unset/);

    const turnSpec = await specOf(turn);
    expect(turnSpec).toMatch(/clear or restore `kind`/);
    expect(turnSpec).toMatch(/`kind: human`/);
  });

  it("is idempotent on the guidance prose too", async () => {
    const pva = await seedSuggestion(OLD_PERSON_VS_AGENT);
    await db.exec(schemaSql);
    const once = await specOf(pva);
    await db.exec(schemaSql);
    expect(await specOf(pva)).toBe(once);
  });

  it("leaves the deterministic body_md floor untouched — it stays on `body_md`, never `kind`", async () => {
    const id = await seedBodyMdFloor();
    await db.exec(schemaSql);
    const pred = await predicateOf(id);
    expect(pred.sub_kind).toBe("requires_field");
    expect(pred.fields).toEqual(["body_md"]);
    // Crucially: the floor must NOT have been rewritten to require `kind`.
    expect(pred.fields).not.toContain("kind");
  });

  it("does NOT touch the same OLD judge on a non-org-chart Doco (scoped by template_handle)", async () => {
    await ensureOrgChartDoco("doco_bp", "business-processes");
    const id = await seedProbabilistic(OLD_JUDGE_SPEC, "doco_bp");
    await db.exec(schemaSql);
    // Scoped to org-chart Docos, so a business-processes Doco's row is unchanged.
    expect(await specOf(id)).toBe(OLD_JUDGE_SPEC);
  });

  it("leaves an unrelated org-chart suggestion untouched", async () => {
    const other =
      "An org chart describes who reports to whom and which teams exist — not what those people do.";
    const id = await seedSuggestion(other);
    await db.exec(schemaSql);
    expect(await specOf(id)).toBe(other);
  });
});
