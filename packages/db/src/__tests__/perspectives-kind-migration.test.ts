// The perspectives `kind` CHECK was changed from the legacy `bpmn` value to
// `process` (#1062), and the built-in seed now inserts `kind='process'`. But
// `CREATE TABLE IF NOT EXISTS` never alters an existing table's constraint, so a
// production DB provisioned before #1062 still carries the OLD CHECK that allows
// `bpmn` but forbids `process`. The seed (which runs near the top of schema.sql)
// inserts the `process` row and trips that old constraint — aborting the ENTIRE
// schema apply and 500'ing every DB-backed route, because schema.sql is applied
// as one multi-statement query and a single failing statement rolls back the lot.
//
// The drop→rename→re-add migration that relaxes the constraint must therefore run
// BEFORE the seed, not after it. This test seeds the OLD shape (old constraint +
// a `bpmn` row), re-applies the baseline (what every boot does), and asserts the
// apply succeeds and converges the row onto `process`. It also asserts idempotency.
//
// Mirrors the sibling migration tests (construct a PGlite, exec schema.sql,
// pre-seed old-shape rows, re-exec, assert).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

describe("perspectives `kind` CHECK migration (bpmn → process)", () => {
  it("re-applies cleanly on a DB whose perspectives table predates the `process` kind", async () => {
    const db = new PGlite();
    // Simulate a pre-#1062 production DB: the perspectives table already exists
    // with the OLD kind CHECK (allows `bpmn`, forbids `process`) and a seeded
    // perspective_bpmn row on the old `bpmn` slug/kind. The inline constraint name
    // matches Postgres' default (`perspectives_kind_check`), exactly what the
    // original CREATE TABLE produced in production.
    await db.exec(`
      CREATE TABLE perspectives (
        id           text PRIMARY KEY,
        slug         text NOT NULL UNIQUE,
        kind         text NOT NULL CHECK (kind IN ('graph','list','bpmn','org-tree','sla','glossary','pull-requests')),
        name         text NOT NULL,
        description  text,
        icon         text,
        owner_handle text,
        is_builtin   boolean NOT NULL DEFAULT false,
        config       jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO perspectives (id, slug, kind, name, icon, is_builtin, config)
        VALUES ('perspective_bpmn','bpmn','bpmn','BPMN','🔁',true,'{"lane_axis":"principal"}'::jsonb);
    `);

    // The whole schema must apply without throwing.
    await expect(db.exec(schemaSql)).resolves.toBeDefined();

    // perspective_bpmn converged onto the new `process` identity.
    const r = await db.query<{ kind: string; slug: string }>(
      "SELECT kind, slug FROM perspectives WHERE id = 'perspective_bpmn'",
    );
    expect(r.rows[0]?.kind).toBe("process");
    expect(r.rows[0]?.slug).toBe("process");

    // The canonical constraint is in force: a `process` row is accepted, a row on
    // the now-retired `bpmn` kind is rejected.
    await db.query(
      `INSERT INTO perspectives (id, slug, kind, name, is_builtin)
         VALUES ('perspective_proc_ok','proc-ok','process','OK',false)`,
    );
    await expect(
      db.query(
        `INSERT INTO perspectives (id, slug, kind, name, is_builtin)
           VALUES ('perspective_bpmn_bad','bpmn-bad','bpmn','Bad',false)`,
      ),
    ).rejects.toThrow();

    // Idempotent: a second apply is a no-op and still succeeds.
    await expect(db.exec(schemaSql)).resolves.toBeDefined();
    const r2 = await db.query<{ kind: string }>(
      "SELECT kind FROM perspectives WHERE id = 'perspective_bpmn'",
    );
    expect(r2.rows[0]?.kind).toBe("process");
  });
});
