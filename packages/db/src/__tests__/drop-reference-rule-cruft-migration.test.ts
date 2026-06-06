// Entity-shape normalization, slice C — drop the folded reference/rule cruft
// for good. `ref_type`, `citation`, `severity`, `title`, and `body` were folded
// into the `attributes` bag by earlier column-drop migrations; the owner's plan
// retires them entirely (glossary/SLA stop showing ref_type/citation, the rule
// severity control is gone, the list/search title fallback is gone). After this
// the only non-`extra` content in a node row is real columns.
//
// This pins the idempotent schema.sql migration that converges already-seeded
// production data: it strips the keys from every node's bag, doesn't throw, and
// is a no-op on a second apply (the upgrade path the PGlite-fresh tests miss).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

const DOCO = "doco_cruft00000000000000000000000";
const ORG = "workspace_cruft000000000000000";

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(schemaSql);
  await db.query("INSERT INTO workspaces (id, handle, name) VALUES ($1,$2,$3)", [
    ORG,
    "ws-cruft",
    "WS Cruft",
  ]);
  await db.query(
    "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ($1,$2,$3,$4,'{}'::jsonb)",
    [DOCO, "doco-cruft", ORG, ORG],
  );
  return db;
}

async function bag(db: PGlite, id: string): Promise<Record<string, unknown>> {
  const r = await db.query<{ attributes: Record<string, unknown> }>(
    "SELECT attributes FROM nodes WHERE id = $1",
    [id],
  );
  return r.rows[0].attributes;
}

const CRUFT = ["ref_type", "citation", "severity", "title", "body"] as const;

describe("drop reference/rule cruft from the bag (slice C)", () => {
  it("strips ref_type/citation/severity/title/body from every node's attributes", async () => {
    const db = await seeded();
    // A reference carrying the dropped reference scalars in its bag…
    await db.query(
      `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, locator, attributes)
       VALUES ('reference_cruft0000000000000000', $1, 'reference', 'active', 'PR title',
               'https://github.com/a/b/pull/1',
               jsonb_build_object('ref_type','url','citation','PR#1','title','Old title','content_hash','h1'))`,
      [DOCO],
    );
    // …and a rule carrying the dropped severity + a kept domain field.
    await db.query(
      `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, attributes)
       VALUES ('rule_cruft000000000000000000000', $1, 'rule', 'active', 'Always X',
               jsonb_build_object('severity','hard','enforced_by','policy_1','body','stale'))`,
      [DOCO],
    );

    await db.exec(schemaSql); // re-apply — production does this on every boot

    const refBag = await bag(db, "reference_cruft0000000000000000");
    for (const key of CRUFT) expect(refBag).not.toHaveProperty(key);
    // The kept domain field (and the promoted locator column) survive.
    expect(refBag).toMatchObject({ content_hash: "h1" });
    const r = await db.query<{ prose: string; locator: string | null }>(
      "SELECT prose, locator FROM nodes WHERE id = 'reference_cruft0000000000000000'",
    );
    expect(r.rows[0].prose).toBe("PR title");
    expect(r.rows[0].locator).toBe("https://github.com/a/b/pull/1");

    const ruleBag = await bag(db, "rule_cruft000000000000000000000");
    for (const key of CRUFT) expect(ruleBag).not.toHaveProperty(key);
    expect(ruleBag).toMatchObject({ enforced_by: "policy_1" });
  });

  it("is idempotent — a second apply leaves the stripped bag unchanged", async () => {
    const db = await seeded();
    await db.query(
      `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, attributes)
       VALUES ('reference_idem00000000000000000', $1, 'reference', 'active', 'Title',
               jsonb_build_object('ref_type','url','note','kept'))`,
      [DOCO],
    );
    await db.exec(schemaSql);
    const once = await bag(db, "reference_idem00000000000000000");
    await db.exec(schemaSql);
    const twice = await bag(db, "reference_idem00000000000000000");
    expect(twice).toEqual(once);
    expect(twice).toEqual({ note: "kept" });
  });

  it("upgrade path: old reference/rule COLUMNS fold out then strip, never resurfacing in the bag", async () => {
    const db = new PGlite();
    // Pre-slim-down shape: the reference + rule scalars as real columns.
    await db.exec(`
      CREATE TABLE nodes (
        id text PRIMARY KEY,
        doco_id text NOT NULL,
        node_type text NOT NULL,
        lifecycle text NOT NULL DEFAULT 'active',
        prose text NOT NULL DEFAULT '',
        kind text,
        attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
        ref_type text, locator text, citation text, title text, severity text,
        created_at timestamptz NOT NULL DEFAULT now(),
        created_by text,
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by text
      );
      INSERT INTO nodes (id, doco_id, node_type, prose, ref_type, locator, citation, title, severity)
      VALUES ('reference_oldcol0000000000000000', '${DOCO}', 'reference', 'PR',
              'url', 'https://github.com/a/b/pull/3', 'PR#3', 'Old title', NULL);
    `);

    await db.exec(schemaSql);

    const b = await bag(db, "reference_oldcol0000000000000000");
    for (const key of CRUFT) expect(b).not.toHaveProperty(key);
    // locator is promoted to its column (slice B), not the bag.
    const r = await db.query<{ locator: string | null }>(
      "SELECT locator FROM nodes WHERE id = 'reference_oldcol0000000000000000'",
    );
    expect(r.rows[0].locator).toBe("https://github.com/a/b/pull/3");

    // Idempotent second apply.
    await db.exec(schemaSql);
    expect(await bag(db, "reference_oldcol0000000000000000")).toEqual(b);
  });
});
