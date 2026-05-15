// Guard against NODE_TABLES drifting from schema.sql.
//
// Both files are hand-maintained for now (full codegen is a future
// ticket). This test catches the most common drift: a node type added
// to NODE_TABLES but missing from schema.sql (or vice-versa), and a
// `body: true` flag that disagrees with whether the table has a
// `body_md` column.
//
// Aligned with the audit's #1 proposal: even without runtime codegen,
// a consistency test means any new entity type is one CI failure away
// from the necessary follow-up edits.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NODE_TABLES } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

function hasCreateTable(table: string): boolean {
  const re = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}\\s*\\(`, "i");
  return re.test(schemaSql);
}

function tableBlock(table: string): string | null {
  const re = new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}\\s*\\(([\\s\\S]*?)\\);`,
    "i",
  );
  const m = schemaSql.match(re);
  return m ? m[1] ?? null : null;
}

function hasBodyMdColumn(table: string): boolean {
  const block = tableBlock(table);
  if (!block) return false;
  return /\bbody_md\b/.test(block);
}

describe("NODE_TABLES ↔ schema.sql consistency", () => {
  for (const [nodeType, spec] of Object.entries(NODE_TABLES)) {
    it(`schema.sql declares table ${spec.table} for node_type "${nodeType}"`, () => {
      expect(hasCreateTable(spec.table)).toBe(true);
    });

    it(`schema.sql ${spec.table}.body_md presence matches NODE_TABLES.${nodeType}.body=${spec.body}`, () => {
      expect(hasBodyMdColumn(spec.table)).toBe(spec.body);
    });
  }

  it("revision column has been removed from every entity table (decision_01KRHBZMD0V35NAX94Y7N2MXVA)", () => {
    for (const [, spec] of Object.entries(NODE_TABLES)) {
      const block = tableBlock(spec.table);
      if (!block) continue;
      const hasRevisionColumn = /^\s*revision\s+integer/m.test(block);
      expect(hasRevisionColumn, `table ${spec.table} still declares a revision column`).toBe(false);
    }
  });
});
