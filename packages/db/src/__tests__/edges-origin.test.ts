// Guards the `edges.origin` column added for the "edges as the authored source
// of truth" refactor (option (i)): schema.sql inline column for fresh installs
// + migration 071 for existing DBs.
//
// String/structure assertions over the SQL, not live-DB checks: the package has
// no Postgres in CI (see node-ref-fks.test.ts). They lock in the things that
// are easy to get wrong and dangerous to regress:
//   1. The column exists, is NOT NULL, defaults to 'authored', and is CHECK-
//      constrained to ('authored','field').
//   2. Migration 071 adds it idempotently (ADD COLUMN IF NOT EXISTS) and the
//      CHECK only NOT VALID — the migration-025 lesson: never scan at boot.
//   3. The migration is guarded for a fresh-genesis bootstrap (edges absent).

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const dbRoot = join(here, "..", "..");
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function tableBlock(table: string): string {
  const re = new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}\\s*\\(([\\s\\S]*?)\\);`,
    "i",
  );
  const m = schemaSql.match(re);
  if (!m?.[1]) throw new Error(`could not locate CREATE TABLE ${table} in schema.sql`);
  return stripSqlComments(m[1]);
}

function migration073(): string {
  const dir = join(dbRoot, "migrations");
  // Match the exact file — main carries a second 073 migration
  // (073_drop_entity_fts_policies) from a concurrent PR; both apply (the ledger
  // keys on the full filename), but this test wants the edges.origin one.
  const name = readdirSync(dir).find((f) => /^073_edges_origin\.sql$/.test(f));
  if (!name) throw new Error("073_edges_origin.sql not found");
  return stripSqlComments(readFileSync(join(dir, name), "utf8"));
}

describe("edges.origin — schema.sql baseline", () => {
  const edges = tableBlock("edges");

  it("declares origin text NOT NULL DEFAULT 'authored'", () => {
    expect(/\borigin\b\s+text\s+NOT\s+NULL\s+DEFAULT\s+'authored'/i.test(edges)).toBe(true);
  });

  it("constrains origin to ('authored','field')", () => {
    expect(/CHECK\s*\(\s*origin\s+IN\s*\(\s*'authored'\s*,\s*'field'\s*\)\s*\)/i.test(edges)).toBe(
      true,
    );
  });
});

describe("migration 073 — add edges.origin to existing DBs", () => {
  const sql = migration073();

  it("adds the column idempotently with the 'authored' default", () => {
    expect(
      /ALTER\s+TABLE\s+edges\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+origin\s+text\s+NOT\s+NULL\s+DEFAULT\s+'authored'/i.test(
        sql,
      ),
    ).toBe(true);
  });

  it("adds the CHECK constraint NOT VALID (migration 025 lesson)", () => {
    expect(/ADD\s+CONSTRAINT\s+edges_origin_chk\s+CHECK[\s\S]*?NOT\s+VALID/i.test(sql)).toBe(true);
  });

  it("never runs VALIDATE CONSTRAINT", () => {
    expect(/VALIDATE\s+CONSTRAINT/i.test(sql)).toBe(false);
  });

  it("guards the CHECK add against re-running (idempotent)", () => {
    expect(/IF\s+NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+pg_constraint/i.test(sql)).toBe(true);
  });

  it("is guarded for a fresh-genesis bootstrap (edges may be absent)", () => {
    expect(/to_regclass\(\s*'public\.edges'\s*\)/i.test(sql)).toBe(true);
  });
});
