// Systemic guard for the "schema.sql doesn't reach existing prod tables" class
// of incident (#1142 actor_role 500; #1155 deleted_at index ordering took the
// whole site down). schema.sql re-applies top-to-bottom on EVERY boot
// (applySchema). On a fresh DB the inline CREATE TABLEs make every column, so
// CI/PGlite is green — but a real prod database already has the tables, so an
// inline column is NOT added by `CREATE TABLE IF NOT EXISTS` (it's a no-op) and
// must be healed by an `ADD COLUMN IF NOT EXISTS` in the migration tail. Two
// ways that goes wrong, both invisible to a fresh-DB test:
//   1. A dependent object (index/constraint) that references the new column
//      sits BEFORE the heal in the file → on an existing table the column isn't
//      there yet → the statement errors → the ENTIRE apply aborts → every
//      DB-backed request 500s on cold start (the #1155 outage).
//   2. The heal restores the column but not a dependent object (or vice-versa)
//      → the existing DB never converges to the intended shape.
//
// This guard reconstructs a pre-existing database WITHOUT keeping any historical
// schema (which the repo deliberately doesn't — see current-baseline.test.ts):
// the migration tail's own `ADD COLUMN IF NOT EXISTS` list IS the set of columns
// that older tables predate. Drop them (CASCADE, so their dependent indexes go
// too), re-apply schema.sql, and require that it (a) does not throw and (b)
// converges back to the exact fresh shape.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, schemaSql } from "./fresh-db.js";

/** Columns the migration tail re-adds — i.e. columns an older table can lack. */
function migrationHealedColumns(sql: string): Array<{ table: string; column: string }> {
  const re = /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi;
  return [...sql.matchAll(re)].map((m) => ({ table: m[1], column: m[2] }));
}

/** Canonical shape: every column (with type) + every index, deterministically. */
async function shape(db: PGlite): Promise<{ columns: string[]; indexes: string[] }> {
  const cols = await db.query<{ t: string; c: string; d: string }>(
    `SELECT table_name AS t, column_name AS c, data_type AS d
       FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, column_name`,
  );
  const idx = await db.query<{ n: string }>(
    `SELECT indexname AS n FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`,
  );
  return {
    columns: cols.rows.map((r) => `${r.t}.${r.c}:${r.d}`),
    indexes: idx.rows.map((r) => r.n),
  };
}

let db: PGlite;

describe("schema.sql re-applies cleanly onto a pre-existing database", () => {
  beforeEach(async () => {
    db = await freshDb();
  });

  it("heals every migration-added column and its dependents, in a safe order", async () => {
    const fresh = await shape(db);
    const healed = migrationHealedColumns(schemaSql);
    // If this ever hits zero the regex drifted from the migration syntax — the
    // guard would silently pass without exercising anything.
    expect(healed.length).toBeGreaterThan(0);

    // Reconstruct the pre-existing prod shape: every healed column is absent,
    // along with anything that depended on it.
    for (const { table, column } of healed) {
      await db.exec(`ALTER TABLE ${table} DROP COLUMN IF EXISTS ${column} CASCADE;`);
    }

    // Boot-time convergence. A dependent object placed before its ADD COLUMN
    // (the #1155 class) throws HERE instead of in production.
    await db.exec(schemaSql);

    // Every dropped column AND every dependent index is back: an existing
    // database converges to exactly what a fresh one gets.
    expect(await shape(db)).toEqual(fresh);
  });
});
