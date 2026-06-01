// Guards database-level referential integrity around the unified `nodes`
// and `edges` tables in the current schema baseline.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

// Strip `-- ...` comments so prose that mentions FK syntax can't trip
// the structural assertions.
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

function referencesDeferrable(block: string, col: string, target: string): boolean {
  return new RegExp(
    `\\b${col}\\b[^,]*REFERENCES\\s+${target}\\s*\\(\\s*id\\s*\\)[^,]*DEFERRABLE\\s+INITIALLY\\s+DEFERRED`,
    "i",
  ).test(block);
}

const NODE_SELF_FK = [
  "parent_intent_id",
  "superseded_by_decision_id",
  "actor_id",
  "template_id",
  "decided_by",
] as const;

describe("nodes relationship columns — schema.sql baseline", () => {
  const nodes = tableBlock("nodes");

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
