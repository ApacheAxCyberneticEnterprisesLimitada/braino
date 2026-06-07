// `body_md` is dropped from the node model (entity-shape normalization): a node
// has one text home (`prose`); the only sanctioned bag is the author-owned one,
// which the system never writes to. This pins the schema.sql migrations that
// converge already-seeded production data onto the new shape:
//   1. strip `body_md` from every node's extra bag,
//   2. retire the org-chart `body_md` presence floor (it would block every
//      principal capture now that principals carry no `body_md`),
//   3. converge the org-chart person/agent/vacant judge + guidance to read
//      `kind` + `prose` (never `body_md`),
//   4. the PR-reference title/body "split" now DROPS the body (prose = title),
//   5. the principal column-fold drops `body_md` instead of folding it into the
//      extra bag.
// Every case asserts the apply does not throw, converges the data, and is
// idempotent on a second apply (the upgrade path the PGlite-fresh tests miss).
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, schemaSql } from "./fresh-db.js";

const DOCO = "doco_dropbodymd00000000000000000";
const ORG = "workspace_dropbodymd0000000000";

let db: PGlite;

async function seedDoco(templateHandle: string | null): Promise<void> {
  await db.query("INSERT INTO workspaces (id, handle, name) VALUES ($1, $2, $3)", [
    ORG,
    "ws-dropbodymd",
    "WS DropBodyMd",
  ]);
  await db.query(
    "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ($1,$2,$3,$4,$5::jsonb)",
    [
      DOCO,
      "doco-dropbodymd",
      ORG,
      ORG,
      JSON.stringify(templateHandle ? { template_handle: templateHandle } : {}),
    ],
  );
}

async function insertNode(
  id: string,
  nodeType: string,
  prose: string,
  extra: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, extra)
     VALUES ($1, $2, $3, 'active', $4, $5::jsonb)`,
    [id, DOCO, nodeType, prose, JSON.stringify(extra)],
  );
}

async function readNode(id: string): Promise<{ prose: string; extra: Record<string, unknown> }> {
  const r = await db.query<{ prose: string; extra: Record<string, unknown> }>(
    "SELECT prose, extra FROM nodes WHERE id = $1",
    [id],
  );
  return r.rows[0];
}

async function insertPolicy(
  id: string,
  kind: string,
  lifecycle: string,
  predicate: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO policies (id, doco_id, kind, lifecycle, data)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [id, DOCO, kind, lifecycle, JSON.stringify({ id, doco_id: DOCO, kind, lifecycle, predicate })],
  );
}

async function readPolicy(
  id: string,
): Promise<{ lifecycle: string; instruction: string; data: Record<string, unknown> }> {
  const r = await db.query<{ lifecycle: string; data: Record<string, unknown> }>(
    "SELECT lifecycle, data FROM policies WHERE id = $1",
    [id],
  );
  const data = r.rows[0].data as { predicate?: { agent_instruction?: string } };
  return {
    lifecycle: r.rows[0].lifecycle,
    instruction: data.predicate?.agent_instruction ?? "",
    data: r.rows[0].data,
  };
}

describe("drop body_md migration", () => {
  beforeEach(async () => {
    db = await freshDb();
    await seedDoco("org-chart");
  });

  it("(1) strips body_md from a principal's extra bag", async () => {
    await insertNode("principal_strip0000000000000000", "principal", "Ada — Staff Engineer", {
      body_md: "Long bio that no longer has a home.",
      kind: "human",
    });

    await db.exec(schemaSql); // re-apply (what every boot does)

    const row = await readNode("principal_strip0000000000000000");
    expect(row.prose).toBe("Ada — Staff Engineer");
    expect(row.extra).not.toHaveProperty("body_md");
    // The author-owned content beside it is untouched.
    expect(row.extra).toMatchObject({ kind: "human" });
  });

  it("(2) strips body_md from a reference's extra bag", async () => {
    await insertNode("reference_strip0000000000000000", "reference", "Some PR title", {
      body_md: "The PR body, now dropped.",
      ref_type: "url",
      locator: "https://github.com/acme/store/pull/9",
    });

    await db.exec(schemaSql);

    const row = await readNode("reference_strip0000000000000000");
    expect(row.extra).not.toHaveProperty("body_md");
    // ref_type is also stripped from the bag (slice C); locator is promoted to
    // its column (slice B) — so the bag is left empty.
    expect(row.extra).not.toHaveProperty("ref_type");
    expect(row.extra).not.toHaveProperty("locator");
  });

  it("(3) retires the org-chart body_md presence floor", async () => {
    await insertPolicy("policy_floor00000000000000000000", "deterministic", "active", {
      sub_kind: "requires_field",
      fields: ["body_md"],
      when_node_type: ["principal"],
    });

    await db.exec(schemaSql);

    const p = await readPolicy("policy_floor00000000000000000000");
    expect(p.lifecycle).toBe("retired");
    // mirrors transitionPolicyLifecycle: the data.lifecycle moves too.
    expect(p.data.lifecycle).toBe("retired");
  });

  it("(4) converges the org-chart person/agent/vacant judge to kind+prose", async () => {
    // Interim (post-#1073) shape: keyed off `kind` but still reads `body_md`.
    await insertPolicy("policy_kindjudge00000000000000000", "probabilistic", "active", {
      agent_instruction:
        "Read the Principal's `kind` field and its `body_md` prose. PASS if `kind` is `human` (the seat is filled by a person) or `agent` (filled by an AI agent), OR if `kind` is unset AND the `body_md` prose states the seat is currently vacant/open (e.g. 'Vacant — budgeted Staff Engineer seat, reporting to …'). FAIL with a reason if `kind` is unset AND the prose does not declare the seat vacant — the seat must state whether it's filled by a person, filled by an AI agent, or vacant.",
      when_node_type: ["principal"],
    });

    await db.exec(schemaSql);

    const p = await readPolicy("policy_kindjudge00000000000000000");
    expect(p.instruction).not.toContain("body_md");
    expect(p.instruction).toContain("`kind` field and its `prose`");
    expect(p.instruction).toContain("the `prose` states the seat is currently vacant");
  });

  it("(5) converges the org-chart guidance suggestions to name prose, not body_md", async () => {
    await insertPolicy("policy_sugg_pva00000000000000000", "suggestion", "active", {
      agent_instruction:
        "Person vs agent isn't about who signed in — it's about who fills the seat, declared in the `kind` field. A Principal with `kind: agent` (a code reviewer, a triage bot, a research agent) is an agent regardless of whether any User has signed in as it. A Principal with `kind: human` is a person, even if that human has no Doco account. A vacant seat sets no `kind` and says so in `body_md`.",
    });
    await insertPolicy("policy_sugg_seat0000000000000000", "suggestion", "active", {
      agent_instruction:
        "Treat each Principal as a seat — a role plus its current occupant — not just a person. A filled seat sets `kind` to `human` or `agent`; a budgeted-but-unfilled seat is still a valid Principal: leave `kind` unset, declare it `vacant` in `body_md`, name the role it's budgeted for, and keep its reporting edge so the tree stays complete. Omitting open roles hides headcount and distorts the reporting structure.",
    });
    await insertPolicy("policy_sugg_turn0000000000000000", "suggestion", "active", {
      agent_instruction:
        "Seats persist across routine turnover: when one person leaves and another fills the same seat — or a seat goes vacant and is later refilled by the same kind of occupant — keep the Principal, update `body_md` (and clear or restore `kind` as the seat empties or refills), and record the change as a Decision, so reporting and membership edges stay intact and the seat's history reads continuously. Only when the seat's nature flips between person (`kind: human`) and AI agent (`kind: agent`) do you retire the old Principal and create a new one.",
    });

    await db.exec(schemaSql);

    for (const id of [
      "policy_sugg_pva00000000000000000",
      "policy_sugg_seat0000000000000000",
      "policy_sugg_turn0000000000000000",
    ]) {
      const p = await readPolicy(id);
      expect(p.instruction).not.toContain("body_md");
    }
    expect((await readPolicy("policy_sugg_pva00000000000000000")).instruction).toContain(
      "says so in its `prose`",
    );
    expect((await readPolicy("policy_sugg_seat0000000000000000")).instruction).toContain(
      "declare it `vacant` in its `prose`",
    );
    expect((await readPolicy("policy_sugg_turn0000000000000000")).instruction).toContain(
      "update its `prose`",
    );
  });

  it("(5b) converges the org-chart AI-agent guidance to prose, not body_md", async () => {
    await insertPolicy("policy_sugg_aiagent0000000000000", "suggestion", "active", {
      agent_instruction:
        "AI-agent Principals that act on a human's behalf should declare that human via prose in `body_md` (`Operates under: @alice`), or via a `delegated_by` Decision linking the human Principal to the agent Principal. Autonomous agents (no human owner) state that explicitly so readers know the accountability stops at the agent.",
    });

    await db.exec(schemaSql);

    const p = await readPolicy("policy_sugg_aiagent0000000000000");
    expect(p.instruction).not.toContain("body_md");
    expect(p.instruction).toContain("declare that human in their `prose`");
  });

  it("(5c) converges the process principal-shape judge to prose-only", async () => {
    // Not org-chart-scoped — matched by its opening + 'names a process actor'.
    await insertPolicy("policy_procprincipal000000000000", "probabilistic", "active", {
      agent_instruction:
        "Check the Principal's `prose` and `body_md`. PASS when the Principal clearly names a process actor — a role, team, external party, or system — and the body explains what responsibility or boundary it owns in this process. FAIL if it reads like an uncontextualized org-chart person, a vague label (`user`, `team`, `system`) with no process responsibility, or an empty shell with no body prose.",
      when_node_type: ["principal"],
    });

    await db.exec(schemaSql);

    const p = await readPolicy("policy_procprincipal000000000000");
    expect(p.instruction).not.toContain("body_md");
    expect(p.instruction).toContain(
      "Check the Principal's `prose`. PASS when it clearly names a process actor",
    );
  });

  it("(6) drops the PR-reference body: prose=title, no body_md", async () => {
    await insertNode(
      "reference_prbody00000000000000000",
      "reference",
      "PR title\n\nThe long body.",
      {
        ref_type: "url",
        locator: "https://github.com/acme/store/pull/482",
      },
    );

    await db.exec(schemaSql);

    const row = await readNode("reference_prbody00000000000000000");
    expect(row.prose).toBe("PR title");
    expect(row.extra).not.toHaveProperty("body_md");
  });

  it("(6b) leaves non-PR-URL references untouched (code-locator / issue URL)", async () => {
    await insertNode("reference_codeloc0000000000000000", "reference", "Title\n\nBody", {
      ref_type: "code",
      locator: "src/index.ts:1-20",
    });
    await insertNode("reference_issueurl000000000000000", "reference", "Issue\n\nBody", {
      ref_type: "url",
      locator: "https://github.com/acme/store/issues/7",
    });

    await db.exec(schemaSql);

    expect((await readNode("reference_codeloc0000000000000000")).prose).toBe("Title\n\nBody");
    expect((await readNode("reference_issueurl000000000000000")).prose).toBe("Issue\n\nBody");
  });

  it("(7) is idempotent — re-applying schema.sql leaves the converged state stable", async () => {
    await insertNode("principal_idem00000000000000000", "principal", "Bob", { body_md: "bio" });
    await insertNode("reference_idem0000000000000000000", "reference", "Title\n\nBody", {
      ref_type: "url",
      locator: "https://github.com/acme/store/pull/7",
    });
    await insertPolicy("policy_floor_idem0000000000000000", "deterministic", "active", {
      sub_kind: "requires_field",
      fields: ["body_md"],
      when_node_type: ["principal"],
    });

    await db.exec(schemaSql);
    const once = {
      principal: await readNode("principal_idem00000000000000000"),
      reference: await readNode("reference_idem0000000000000000000"),
      floor: await readPolicy("policy_floor_idem0000000000000000"),
    };
    await db.exec(schemaSql);
    const twice = {
      principal: await readNode("principal_idem00000000000000000"),
      reference: await readNode("reference_idem0000000000000000000"),
      floor: await readPolicy("policy_floor_idem0000000000000000"),
    };

    expect(twice).toEqual(once);
    expect(twice.principal.extra).not.toHaveProperty("body_md");
    expect(twice.reference.prose).toBe("Title");
    expect(twice.floor.lifecycle).toBe("retired");
  });
});

describe("drop body_md migration — principal column fold (old DB upgrade path)", () => {
  it("(8) drops the principal body_md column instead of folding it into extra", async () => {
    db = new PGlite();
    // Recreate the pre-slim-down `nodes` shape: a real `name` + `body_md`
    // column. The principal fold (guarded on the `name` column existing) must
    // move `name` → `prose` and DROP `body_md` — never carry its content into
    // the extra bag.
    await db.exec(`
      CREATE TABLE nodes (
        id text PRIMARY KEY,
        doco_id text NOT NULL,
        node_type text NOT NULL,
        lifecycle text NOT NULL DEFAULT 'active',
        prose text NOT NULL DEFAULT '',
        kind text,
        extra jsonb NOT NULL DEFAULT '{}'::jsonb,
        name text,
        body_md text,
        role_principal boolean,
        created_at timestamptz NOT NULL DEFAULT now(),
        created_by text,
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by text
      );
      INSERT INTO nodes (id, doco_id, node_type, prose, name, body_md)
      VALUES ('principal_old0000000000000000000', '${DOCO}', 'principal', '', 'Carol', 'Old bio prose');
    `);

    await db.exec(schemaSql); // applies the ALTER/fold path

    const row = await readNode("principal_old0000000000000000000");
    expect(row.prose).toBe("Carol");
    expect(row.extra).not.toHaveProperty("body_md");

    // Idempotent second apply.
    await db.exec(schemaSql);
    const again = await readNode("principal_old0000000000000000000");
    expect(again).toEqual(row);
  });
});
