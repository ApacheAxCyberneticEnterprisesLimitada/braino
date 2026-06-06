import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { rowToRecord, upsertEntity } from "../repo.js";
import type { EntityRecord } from "../types.js";

// Node-shape slim-down: a single `attributes` jsonb that replaces the per-type
// promoted columns + `data`. These tests pin the write-path population, the
// idempotent production backfill, the read-path surfacing, and the contract
// drop of the action/log/rule scalar columns (verb / severity / …).

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

const DOCO = "doco_attrs0000000000000000000000";
const ORG = "workspace_attrs00000000000000";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(schemaSql);
  await db.query("INSERT INTO workspaces (id, handle, name) VALUES ($1, $2, $3)", [
    ORG,
    "workspace-attrs",
    "Workspace Attrs",
  ]);
  await db.query(
    "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ($1,$2,$3,$4,'{}'::jsonb)",
    [DOCO, "doco-attrs", ORG, ORG],
  );
});

describe("node attributes column (Stage 1 — expand)", () => {
  it("collapses a reference's per-type fields into attributes on write", async () => {
    const id = "reference_attrs00000000000000000";
    const rec = {
      id,
      doco_id: DOCO,
      entity_type: "reference",
      data: {
        id,
        doco_id: DOCO,
        node_type: "reference",
        reference: "ACME PR #1",
        ref_type: "url",
        locator: "https://example.com/acme/pull/1",
        citation: "PR#1",
        title: "Add the widget",
        content_hash: "abc123",
        pr_body: "The full body of the pull request goes here.",
        lifecycle: "active",
      },
      type_named_value: "ACME PR #1",
      lifecycle: "active",
    } as unknown as EntityRecord;
    await upsertEntity(rec, db as never);

    const { rows } = await db.query<{
      locator: string | null;
      attributes: Record<string, unknown>;
    }>("SELECT locator, attributes FROM nodes WHERE id = $1", [id]);
    const attrs = rows[0].attributes;
    // `locator` is promoted to its own typed column, not the bag.
    expect(rows[0].locator).toBe("https://example.com/acme/pull/1");
    expect(attrs).not.toHaveProperty("locator");
    // The free-form per-type fields land in the unified bag…
    expect(attrs).toMatchObject({
      content_hash: "abc123",
      pr_body: "The full body of the pull request goes here.",
    });
    // …the retired reference scalars (slice C) never reach it…
    expect(attrs).not.toHaveProperty("ref_type");
    expect(attrs).not.toHaveProperty("citation");
    expect(attrs).not.toHaveProperty("title");
    // …and prose / identity / lifecycle never leak into it.
    expect(attrs).not.toHaveProperty("reference");
    expect(attrs).not.toHaveProperty("prose");
    expect(attrs).not.toHaveProperty("id");
    expect(attrs).not.toHaveProperty("node_type");
    expect(attrs).not.toHaveProperty("lifecycle");
  });

  it("keeps a per-type scalar (action.verb) in attributes, not as a leaked key", async () => {
    const id = "action_attrs00000000000000000000";
    const rec = {
      id,
      doco_id: DOCO,
      entity_type: "action",
      data: {
        id,
        doco_id: DOCO,
        node_type: "action",
        action: "Deployed the build",
        verb: "deploy",
        outputs: { url: "https://x" },
        lifecycle: "active",
      },
      type_named_value: "Deployed the build",
      lifecycle: "active",
    } as unknown as EntityRecord;
    await upsertEntity(rec, db as never);

    const { rows } = await db.query<{ attributes: Record<string, unknown> }>(
      "SELECT attributes FROM nodes WHERE id = $1",
      [id],
    );
    expect(rows[0].attributes).toMatchObject({ verb: "deploy", outputs: { url: "https://x" } });
    expect(rows[0].attributes).not.toHaveProperty("action");
  });

  it("folds legacy reference columns + the dropped data jsonb into attributes, then drops them (contract migration)", async () => {
    // Simulate a DB written before the slim-down: re-add the dropped reference
    // columns AND the catch-all `data` jsonb, then insert a row carrying its
    // values in those columns with `attributes` still empty and a stray
    // non-promoted field living only in `data`.
    await db.exec(
      `ALTER TABLE nodes ADD COLUMN IF NOT EXISTS ref_type text,
                         ADD COLUMN IF NOT EXISTS locator text,
                         ADD COLUMN IF NOT EXISTS citation text,
                         ADD COLUMN IF NOT EXISTS title text,
                         ADD COLUMN IF NOT EXISTS data jsonb NOT NULL DEFAULT '{}'::jsonb`,
    );
    const id = "reference_legacy0000000000000000";
    await db.query(
      `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, attributes, ref_type, locator, title, data)
       VALUES ($1,$2,'reference','active','Legacy ref','{}'::jsonb,'url',$3,'Legacy title',$4::jsonb)`,
      [id, DOCO, "https://example.com/acme/pull/9", JSON.stringify({ note: "kept" })],
    );

    // Re-applying schema.sql runs the guarded `data`→attributes backfill, the
    // reference-column fold, and the column drops — production does this on
    // every boot.
    await db.exec(schemaSql);

    const { rows } = await db.query<{
      locator: string | null;
      attributes: Record<string, unknown>;
    }>("SELECT locator, attributes FROM nodes WHERE id = $1", [id]);
    // `locator` is folded out of the legacy column AND promoted to its own
    // typed column (Slice B), not left in the bag.
    expect(rows[0].locator).toBe("https://example.com/acme/pull/9");
    expect(rows[0].attributes).not.toHaveProperty("locator");
    // ref_type / title fold out of the legacy columns but are then dropped from
    // the bag (slice C); only the stray `data`-only field survives the backfill.
    expect(rows[0].attributes).toMatchObject({ note: "kept" });
    expect(rows[0].attributes).not.toHaveProperty("ref_type");
    expect(rows[0].attributes).not.toHaveProperty("title");
    const after = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'nodes'",
    );
    const remaining = after.rows.map((r) => r.column_name);
    expect(remaining).not.toContain("ref_type");
    // The catch-all `data` jsonb is dropped by the same re-applied schema.
    expect(remaining).not.toContain("data");
  });

  it("drops every per-type scalar column, serving them from attributes (contract)", async () => {
    const cols = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'nodes'",
    );
    const names = cols.rows.map((r) => r.column_name);
    for (const dropped of [
      "verb",
      "performed_at",
      "happened_at",
      "severity",
      "phase",
      "on_violation",
      "ref_type",
      "citation",
      "title",
      // principal columns folded into prose / attributes
      "name",
      "body_md",
      "role_principal",
      // the catch-all jsonb, now replaced entirely by `attributes`
      "data",
    ]) {
      expect(names).not.toContain(dropped);
    }
    // The promoted scalars that keep their own column: `kind` (eval/state/
    // principal) and `locator` (the reference dedup key).
    expect(names).toContain("kind");
    expect(names).toContain("locator");

    const id = "action_contract00000000000000000";
    await upsertEntity(
      {
        id,
        doco_id: DOCO,
        entity_type: "action",
        data: {
          id,
          doco_id: DOCO,
          node_type: "action",
          action: "Deployed the build",
          verb: "deploy",
          lifecycle: "active",
        },
        type_named_value: "Deployed the build",
        lifecycle: "active",
      } as unknown as EntityRecord,
      db as never,
    );
    const { rows } = await db.query<Record<string, unknown>>("SELECT * FROM nodes WHERE id = $1", [
      id,
    ]);
    const rec = rowToRecord("action", rows[0]);
    // verb is gone as a column but still reachable on the record, via attributes.
    expect(rec.attributes).toMatchObject({ verb: "deploy" });
    expect(rec.data.verb).toBe("deploy");
  });

  it("surfaces the attributes column onto the record on read (Stage 2 — raw schema)", () => {
    const rec = rowToRecord("reference", {
      id: "reference_read000000000000000000",
      doco_id: DOCO,
      node_type: "reference",
      prose: "ACME PR #1",
      attributes: { ref_type: "url", locator: "https://x", pr_body: "the body" },
      data: {},
    });
    expect(rec.attributes).toEqual({ ref_type: "url", locator: "https://x", pr_body: "the body" });
    expect(rec.data.prose).toBe("ACME PR #1");
  });

  it("no longer writes the dropped data column; the write path persists only attributes (Stage 3 — drop)", async () => {
    const cols = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'nodes'",
    );
    expect(cols.rows.map((r) => r.column_name)).not.toContain("data");

    // upsertNode must not reference the gone `data` column.
    const id = "decision_drop00000000000000000000";
    await upsertEntity(
      {
        id,
        doco_id: DOCO,
        entity_type: "decision",
        data: {
          id,
          doco_id: DOCO,
          node_type: "decision",
          decision: "Adopt the plan",
          chosen: "Route A",
          lifecycle: "active",
        },
        type_named_value: "Adopt the plan",
        lifecycle: "active",
      } as unknown as EntityRecord,
      db as never,
    );
    const { rows } = await db.query<{ attributes: Record<string, unknown> }>(
      "SELECT attributes FROM nodes WHERE id = $1",
      [id],
    );
    // The domain field round-trips through `attributes`, not a `data` column.
    expect(rows[0].attributes).toMatchObject({ chosen: "Route A" });
  });

  it("rebuilds rec.data from attributes + the real columns once data is gone, incl. idea.proposer_id", async () => {
    const id = "idea_proposer00000000000000000000";
    const proposer = "user_proposer00000000000000000000";
    // proposer_id FKs to users(id); seed the OAuth identity first.
    await db.query("INSERT INTO users (id, data) VALUES ($1, '{}'::jsonb)", [proposer]);
    await upsertEntity(
      {
        id,
        doco_id: DOCO,
        entity_type: "idea",
        data: {
          id,
          doco_id: DOCO,
          node_type: "idea",
          idea: "Try the widget",
          proposer_id: proposer,
          tradeoffs: "cheap but slow",
          lifecycle: "active",
        },
        type_named_value: "Try the widget",
        lifecycle: "active",
        created_by: proposer,
      } as unknown as EntityRecord,
      db as never,
    );
    // `proposer_id` lives ONLY in its real column — excluded from attributes,
    // and the `data` column is gone — so it must come back via the column merge.
    const { rows } = await db.query<{ attributes: Record<string, unknown> }>(
      "SELECT attributes FROM nodes WHERE id = $1",
      [id],
    );
    expect(rows[0].attributes).not.toHaveProperty("proposer_id");
    expect(rows[0].attributes).toMatchObject({ tradeoffs: "cheap but slow" });

    const fullRow = (
      await db.query<Record<string, unknown>>("SELECT * FROM nodes WHERE id = $1", [id])
    ).rows[0];
    const rec = rowToRecord("idea", fullRow);
    // System keys injected from real columns…
    expect(rec.data.id).toBe(id);
    expect(rec.data.doco_id).toBe(DOCO);
    expect(rec.data.node_type).toBe("idea");
    expect(rec.data.lifecycle).toBe("active");
    expect(rec.data.created_by).toBe(proposer);
    // …the promoted FK column surfaced…
    expect(rec.data.proposer_id).toBe(proposer);
    // …and the per-type domain field from attributes.
    expect(rec.data.tradeoffs).toBe("cheap but slow");
  });

  it("rowToRecord injects system keys from columns without any data column present", () => {
    const rec = rowToRecord("decision", {
      id: "decision_sys000000000000000000000",
      doco_id: DOCO,
      node_type: "decision",
      lifecycle: "queued",
      prose: "Pick the path",
      attributes: { chosen: "Route A" },
      created_by: "user_alice0000000000000000000000",
      created_at: new Date("2026-01-02T03:04:05.000Z"),
    });
    expect(rec.data).toMatchObject({
      id: "decision_sys000000000000000000000",
      doco_id: DOCO,
      node_type: "decision",
      lifecycle: "queued",
      created_by: "user_alice0000000000000000000000",
      created_at: "2026-01-02T03:04:05.000Z",
      chosen: "Route A",
    });
    // No stray `data` round-trip and no leaked prose key.
    expect(rec.data).not.toHaveProperty("decision");
  });
});
