// `locator` becomes a real `nodes.locator` column (entity-shape normalization,
// slice B): it is the one node domain field we keep — the reference dedup key —
// so it earns a typed column instead of living in the open-ended bag. This pins
// the schema.sql migration that converges already-seeded production data:
//   1. add the `nodes.locator` column,
//   2. move `extra->>'locator'` into it and strip it from the bag,
//   3. repoint the reference-dedup index `nodes_ref_locator_idx` from the
//      `(extra->>'locator')` expression onto the `locator` column,
//   4. the PR-reference body-drop migration reads the `locator` column.
// Each case asserts the apply doesn't throw, converges, and is idempotent on a
// second apply (the upgrade path the PGlite-fresh tests miss).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

const DOCO = "doco_locator0000000000000000000";
const ORG = "workspace_locator000000000000";

let db: PGlite;

async function seedDoco(): Promise<void> {
  await db.query("INSERT INTO workspaces (id, handle, name) VALUES ($1, $2, $3)", [
    ORG,
    "ws-locator",
    "WS Locator",
  ]);
  await db.query(
    "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ($1,$2,$3,$4,'{}'::jsonb)",
    [DOCO, "doco-locator", ORG, ORG],
  );
}

async function insertReference(
  id: string,
  prose: string,
  extra: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, extra)
     VALUES ($1, $2, 'reference', 'active', $3, $4::jsonb)`,
    [id, DOCO, prose, JSON.stringify(extra)],
  );
}

async function readRef(
  id: string,
): Promise<{ prose: string; locator: string | null; extra: Record<string, unknown> }> {
  const r = await db.query<{
    prose: string;
    locator: string | null;
    extra: Record<string, unknown>;
  }>("SELECT prose, locator, extra FROM nodes WHERE id = $1", [id]);
  return r.rows[0];
}

async function indexDef(name: string): Promise<string | undefined> {
  const r = await db.query<{ indexdef: string }>(
    "SELECT indexdef FROM pg_indexes WHERE indexname = $1",
    [name],
  );
  return r.rows[0]?.indexdef;
}

describe("promote locator to a column migration", () => {
  beforeEach(async () => {
    db = new PGlite();
    await db.exec(schemaSql);
    await seedDoco();
  });

  it("(1) moves extra.locator into the locator column and strips it from the bag", async () => {
    await insertReference("reference_move00000000000000000", "Some PR title", {
      locator: "https://github.com/acme/store/pull/9",
      ref_type: "url",
    });

    await db.exec(schemaSql); // re-apply (what every boot does)

    const row = await readRef("reference_move00000000000000000");
    expect(row.locator).toBe("https://github.com/acme/store/pull/9");
    expect(row.extra).not.toHaveProperty("locator");
    // `ref_type` is also dropped from the bag (slice C).
    expect(row.extra).not.toHaveProperty("ref_type");
  });

  it("(2) repoints the reference-dedup index onto the `locator` column", async () => {
    await db.exec(schemaSql);
    const def = await indexDef("nodes_ref_locator_idx");
    expect(def).toBeDefined();
    // The index is now on the column, not the `extra->>'locator'` expression.
    expect(def).toMatch(/\blocator\b/);
    expect(def).not.toMatch(/extra/);
  });

  it("(3) the PR-reference body drop reads the `locator` column", async () => {
    await insertReference("reference_prbody00000000000000000", "PR title\n\nThe body.", {
      locator: "https://github.com/acme/store/pull/482",
      ref_type: "url",
    });

    await db.exec(schemaSql);

    const row = await readRef("reference_prbody00000000000000000");
    expect(row.prose).toBe("PR title");
    expect(row.locator).toBe("https://github.com/acme/store/pull/482");
  });

  it("(4) a dedup lookup by the locator column finds the matching reference", async () => {
    await insertReference("reference_dedup00000000000000000", "PR", {
      locator: "https://github.com/acme/store/pull/77",
      ref_type: "url",
    });

    await db.exec(schemaSql);

    const r = await db.query<{ id: string }>(
      "SELECT id FROM nodes WHERE doco_id = $1 AND node_type = 'reference' AND locator = $2",
      [DOCO, "https://github.com/acme/store/pull/77"],
    );
    expect(r.rows.map((row) => row.id)).toContain("reference_dedup00000000000000000");
  });

  it("(5) is idempotent — re-applying schema.sql leaves the converged state stable", async () => {
    await insertReference("reference_idem00000000000000000", "Title", {
      locator: "https://github.com/acme/store/pull/7",
      ref_type: "url",
    });

    await db.exec(schemaSql);
    const once = await readRef("reference_idem00000000000000000");
    await db.exec(schemaSql);
    const twice = await readRef("reference_idem00000000000000000");

    expect(twice).toEqual(once);
    expect(twice.locator).toBe("https://github.com/acme/store/pull/7");
    expect(twice.extra).not.toHaveProperty("locator");
  });
});

describe("promote locator migration — old DB upgrade path (no locator column)", () => {
  it("(6) adds the locator column to an old nodes table and migrates the bag value in", async () => {
    db = new PGlite();
    // Pre-slice-B shape: a `nodes` table WITHOUT the `locator` column, with the
    // locator living in the extra bag and the OLD expression index.
    await db.exec(`
      CREATE TABLE nodes (
        id text PRIMARY KEY,
        doco_id text NOT NULL,
        node_type text NOT NULL,
        lifecycle text NOT NULL DEFAULT 'active',
        prose text NOT NULL DEFAULT '',
        kind text,
        extra jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        created_by text,
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by text
      );
      CREATE INDEX nodes_ref_locator_idx ON nodes (doco_id, (extra->>'locator')) WHERE node_type = 'reference';
      INSERT INTO nodes (id, doco_id, node_type, prose, extra)
      VALUES ('reference_old00000000000000000', '${DOCO}', 'reference', 'Old PR',
              jsonb_build_object('locator','https://github.com/acme/store/pull/1','ref_type','url'));
    `);

    await db.exec(schemaSql); // applies the ALTER + migrate + index repoint

    const row = await readRef("reference_old00000000000000000");
    expect(row.locator).toBe("https://github.com/acme/store/pull/1");
    expect(row.extra).not.toHaveProperty("locator");
    const def = await indexDef("nodes_ref_locator_idx");
    expect(def).toMatch(/\blocator\b/);
    expect(def).not.toMatch(/extra/);

    // Idempotent second apply.
    await db.exec(schemaSql);
    const again = await readRef("reference_old00000000000000000");
    expect(again).toEqual(row);
  });
});
