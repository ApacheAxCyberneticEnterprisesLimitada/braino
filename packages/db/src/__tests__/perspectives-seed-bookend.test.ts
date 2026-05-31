// Regression for the #717 production incident: applying schema.sql to an
// EXISTING database must not throw.
//
// schema.sql is applied first in the ensureSchema bookend. On an existing DB,
// `CREATE TABLE IF NOT EXISTS perspectives` is skipped, so the table keeps the
// auto-named `perspectives_kind_check` it was created with. #717 grew the kind
// allow-list (added 'pull-requests') AND added a seed row of that kind — but the
// inline CHECK in CREATE TABLE never re-applies to an existing table, so the
// pass-1 seed violated the OLD constraint and ensureSchema threw for every
// request ("new row for relation perspectives violates check constraint"),
// taking all DB-backed routes down. schema.sql must re-assert the widened
// constraint BEFORE seeding so existing DBs heal themselves.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

describe("schema.sql on an existing DB (perspectives kind CHECK regression)", () => {
  it("heals a perspectives table created with the pre-'pull-requests' CHECK", async () => {
    const db = new PGlite();
    // Simulate a production DB created before 'pull-requests' existed: the
    // perspectives table with the OLD auto-named CHECK (no 'pull-requests').
    await db.exec(`
      CREATE TABLE perspectives (
        id           text PRIMARY KEY,
        slug         text NOT NULL UNIQUE,
        kind         text NOT NULL CHECK (kind IN ('graph','list','bpmn','org-tree','sla','approval','glossary')),
        name         text NOT NULL,
        description  text,
        icon         text,
        owner_handle text,
        is_builtin   boolean NOT NULL DEFAULT false,
        config       jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO perspectives (id, slug, kind, name, is_builtin)
        VALUES ('perspective_graph','graph','graph','Graph',true);
    `);

    // Applying the current baseline must NOT throw (the seed used to violate
    // the old constraint), and the new built-in row must land.
    await expect(db.exec(schemaSql)).resolves.toBeDefined();
    const { rows } = await db.query<{ id: string }>(
      "SELECT id FROM perspectives WHERE kind = 'pull-requests'",
    );
    expect(rows).toHaveLength(1);
    await db.close();
  });
});
