// Guards the database-level referential integrity around the unified `nodes`
// and `edges` tables across migrations 070 (restore) and 074 (drop the
// node→node columns in favour of edges) plus schema.sql.
//
// String/structure assertions over the SQL, not live-DB checks: the package
// has no Postgres in CI (see schema-consistency test). They lock in the things
// that are easy to get wrong and dangerous to regress:
//   1. The five intra-graph node→node relationship columns are GONE from
//      schema.sql and dropped by migration 074 (option (i): each is a
//      first-class `edges` row now). Migration 070 still documents the FKs it
//      added (historical; 074 reverses the node self-FK half).
//   2. `proposer_id` FKs to USERS(id) (an OAuth identity, not a node), stays a
//      column, and must NOT point at nodes — it is not a node→node edge.
//   3. Both `edges` endpoints FK to nodes(id), DEFERRABLE — edges are node↔node.
//   4. The restore migration only ADDs constraints NOT VALID and never
//      VALIDATEs — the explicit lesson from migration 025's production incident.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const dbRoot = join(here, "..", "..");
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

// Strip `-- …` comments so prose that mentions FK syntax (e.g. the migration's
// own note about a future VALIDATE) can't trip the structural assertions.
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

function migration070(): string {
  const dir = join(dbRoot, "migrations");
  const name = readdirSync(dir).find((f) => /^070_.*\.sql$/.test(f));
  if (!name) throw new Error("migration 070_*.sql not found");
  return stripSqlComments(readFileSync(join(dir, name), "utf8"));
}

function migration074(): string {
  const dir = join(dbRoot, "migrations");
  const name = readdirSync(dir).find((f) => /^074_.*\.sql$/.test(f));
  if (!name) throw new Error("migration 074_*.sql not found");
  return stripSqlComments(readFileSync(join(dir, name), "utf8"));
}

function referencesDeferrable(block: string, col: string, target: string): boolean {
  return new RegExp(
    `\\b${col}\\b[^,]*REFERENCES\\s+${target}\\s*\\(\\s*id\\s*\\)[^,]*DEFERRABLE\\s+INITIALLY\\s+DEFERRED`,
    "i",
  ).test(block);
}

// The five refs whose target is unambiguously a node type (per migration 013).
const NODE_SELF_FK = [
  "parent_intent_id",
  "superseded_by_decision_id",
  "actor_id",
  "template_id",
  "decided_by",
] as const;

describe("nodes relationship columns — schema.sql baseline", () => {
  const nodes = tableBlock("nodes");

  // Option (i): the five node→node relationship columns were dropped (migration
  // 074) — each is a first-class `edges` row now. schema.sql must no longer
  // declare them, so fresh installs get the post-drop shape. (tableBlock strips
  // `-- comments`, so the prose naming them in the schema doesn't count.)
  for (const col of NODE_SELF_FK) {
    it(`${col} is no longer a column on nodes (moved to edges)`, () => {
      expect(new RegExp(`\\b${col}\\b`).test(nodes)).toBe(false);
    });
  }

  it("proposer_id FKs to users(id) (an OAuth identity, not a node)", () => {
    expect(/\bproposer_id\b[^,]*REFERENCES\s+users\s*\(\s*id\s*\)/i.test(nodes)).toBe(true);
  });

  it("proposer_id does NOT reference nodes(id)", () => {
    expect(/\bproposer_id\b[^,]*REFERENCES\s+nodes/i.test(nodes)).toBe(false);
  });
});

describe("edges endpoint FKs — schema.sql baseline", () => {
  const edges = tableBlock("edges");

  for (const col of ["from_id", "to_id"] as const) {
    it(`${col} FKs to nodes(id), DEFERRABLE (edges are node↔node)`, () => {
      expect(referencesDeferrable(edges, col, "nodes")).toBe(true);
    });
  }
});

describe("migration 070 — restore FKs on existing DBs", () => {
  const sql = migration070();

  for (const col of NODE_SELF_FK) {
    it(`adds an FK on nodes.${col} → nodes(id), DEFERRABLE NOT VALID`, () => {
      const re = new RegExp(
        `FOREIGN KEY\\s*\\(\\s*${col}\\s*\\)\\s*REFERENCES\\s+nodes\\s*\\(\\s*id\\s*\\)\\s*DEFERRABLE\\s+INITIALLY\\s+DEFERRED\\s+NOT\\s+VALID`,
        "i",
      );
      expect(re.test(sql)).toBe(true);
    });
  }

  it("adds nodes.proposer_id → users(id) ON DELETE SET NULL NOT VALID", () => {
    expect(
      /FOREIGN KEY\s*\(\s*proposer_id\s*\)\s*REFERENCES\s+users\s*\(\s*id\s*\)\s*ON\s+DELETE\s+SET\s+NULL\s+NOT\s+VALID/i.test(
        sql,
      ),
    ).toBe(true);
  });

  for (const col of ["from_id", "to_id"] as const) {
    it(`adds an FK on edges.${col} → nodes(id), DEFERRABLE NOT VALID`, () => {
      const re = new RegExp(
        `FOREIGN KEY\\s*\\(\\s*${col}\\s*\\)\\s*REFERENCES\\s+nodes\\s*\\(\\s*id\\s*\\)\\s*DEFERRABLE\\s+INITIALLY\\s+DEFERRED\\s+NOT\\s+VALID`,
        "i",
      );
      expect(re.test(sql)).toBe(true);
    });
  }

  it("never runs VALIDATE CONSTRAINT (migration 025 lesson)", () => {
    expect(/VALIDATE\s+CONSTRAINT/i.test(sql)).toBe(false);
  });

  it("is guarded for a fresh-genesis bootstrap (nodes + edges may be absent)", () => {
    expect(/to_regclass\(\s*'public\.nodes'\s*\)/i.test(sql)).toBe(true);
    expect(/to_regclass\(\s*'public\.edges'\s*\)/i.test(sql)).toBe(true);
  });

  it("guards each ADD against re-running (idempotent: 8 constraints)", () => {
    const guards = sql.match(/IF\s+NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+pg_constraint/gi) ?? [];
    expect(guards.length).toBe(8);
  });
});

describe("migration 074 — drop the node→node relationship columns", () => {
  const sql = migration074();

  for (const col of NODE_SELF_FK) {
    it(`drops nodes.${col} (DROP COLUMN cascades its FK + indexes)`, () => {
      expect(new RegExp(`DROP\\s+COLUMN\\s+IF\\s+EXISTS\\s+${col}\\b`, "i").test(sql)).toBe(true);
    });
  }

  it("does NOT drop proposer_id (an OAuth identity ref, not a node→node edge)", () => {
    expect(/DROP\s+COLUMN\s+IF\s+EXISTS\s+proposer_id\b/i.test(sql)).toBe(false);
  });

  it("is guarded for a fresh-genesis bootstrap (nodes may be absent)", () => {
    expect(/to_regclass\(\s*'public\.nodes'\s*\)/i.test(sql)).toBe(true);
  });
});
