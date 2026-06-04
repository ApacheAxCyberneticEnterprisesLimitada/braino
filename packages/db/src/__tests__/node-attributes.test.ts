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
  await db.query("INSERT INTO workspaces (id, handle, name, data) VALUES ($1,$2,$3,'{}'::jsonb)", [
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

    const { rows } = await db.query<{ attributes: Record<string, unknown> }>(
      "SELECT attributes FROM nodes WHERE id = $1",
      [id],
    );
    const attrs = rows[0].attributes;
    // Every per-type field lands in the unified bag…
    expect(attrs).toMatchObject({
      ref_type: "url",
      locator: "https://example.com/acme/pull/1",
      citation: "PR#1",
      title: "Add the widget",
      content_hash: "abc123",
      pr_body: "The full body of the pull request goes here.",
    });
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

  it("folds legacy reference columns into attributes, then drops them (contract migration)", async () => {
    // Simulate a DB written before the reference contract: re-add the dropped
    // columns, insert a row carrying its values in them with attributes still
    // empty and a stray non-promoted field in `data`.
    await db.exec(
      `ALTER TABLE nodes ADD COLUMN IF NOT EXISTS ref_type text,
                         ADD COLUMN IF NOT EXISTS locator text,
                         ADD COLUMN IF NOT EXISTS citation text,
                         ADD COLUMN IF NOT EXISTS title text`,
    );
    const id = "reference_legacy0000000000000000";
    await db.query(
      `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, attributes, ref_type, locator, title, data)
       VALUES ($1,$2,'reference','active','Legacy ref','{}'::jsonb,'url',$3,'Legacy title',$4::jsonb)`,
      [id, DOCO, "https://example.com/acme/pull/9", JSON.stringify({ note: "kept" })],
    );

    // Re-applying schema.sql runs the guarded fold + drop — production does this
    // on every boot.
    await db.exec(schemaSql);

    const { rows } = await db.query<{ attributes: Record<string, unknown> }>(
      "SELECT attributes FROM nodes WHERE id = $1",
      [id],
    );
    expect(rows[0].attributes).toMatchObject({
      ref_type: "url",
      locator: "https://example.com/acme/pull/9",
      title: "Legacy title",
      note: "kept",
    });
    const after = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'nodes'",
    );
    expect(after.rows.map((r) => r.column_name)).not.toContain("ref_type");
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
      "locator",
      "citation",
      "title",
    ]) {
      expect(names).not.toContain(dropped);
    }
    // `kind` is the last promoted scalar this phase.
    expect(names).toContain("kind");

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
    expect(rec.type_named_value).toBe("ACME PR #1");
  });
});
