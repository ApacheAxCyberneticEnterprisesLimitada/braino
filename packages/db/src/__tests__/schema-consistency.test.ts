// Guard against entity-type table maps drifting from schema.sql.
//
// Catches the most common drift: an entity type added to one of the
// table maps but missing from schema.sql (or vice-versa), and a
// `body: true` flag that disagrees with whether the table has a
// `body_md` column.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_ENTITY_TABLES } from "../types.js";

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
  return m ? (m[1] ?? null) : null;
}

function hasBodyMdColumn(table: string): boolean {
  const block = tableBlock(table);
  if (!block) return false;
  return /\bbody_md\b/.test(block);
}

function hasTypeNamedColumn(table: string, column: string): boolean {
  const block = tableBlock(table);
  if (!block) return false;
  return new RegExp(`(^|\\s|,)${column}\\s+text\\b`, "m").test(block);
}

describe("ALL_ENTITY_TABLES ↔ schema.sql consistency", () => {
  for (const [nodeType, spec] of Object.entries(ALL_ENTITY_TABLES)) {
    it(`schema.sql declares table ${spec.table} for node_type "${nodeType}"`, () => {
      expect(hasCreateTable(spec.table)).toBe(true);
    });

    if (spec.typeNamedColumn) {
      it(`schema.sql ${spec.table} declares type-named column "${spec.typeNamedColumn}"`, () => {
        expect(hasTypeNamedColumn(spec.table, spec.typeNamedColumn as string)).toBe(true);
      });
    }
  }

  // A node's only text is its single `prose` column — no entity table carries a
  // separate `body_md`. (The `body` flag that used to encode this per-table is
  // gone; the invariant is now asserted directly.)
  it("no entity table declares a body_md column", () => {
    for (const [, spec] of Object.entries(ALL_ENTITY_TABLES)) {
      expect(hasBodyMdColumn(spec.table), `table ${spec.table} still declares body_md`).toBe(false);
    }
  });

  it("revision column has been removed from every entity table (decision_01KRHBZMD0V35NAX94Y7N2MXVA)", () => {
    for (const [, spec] of Object.entries(ALL_ENTITY_TABLES)) {
      const block = tableBlock(spec.table);
      if (!block) continue;
      const hasRevisionColumn = /^\s*revision\s+integer/m.test(block);
      expect(hasRevisionColumn, `table ${spec.table} still declares a revision column`).toBe(false);
    }
  });
});
