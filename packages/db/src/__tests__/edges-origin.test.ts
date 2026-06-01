// Guards the `edges.origin` column in the current schema baseline.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
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

describe("edges.origin — schema.sql baseline", () => {
  const edges = tableBlock("edges");

  it("declares origin text NOT NULL DEFAULT 'authored'", () => {
    expect(/\borigin\b\s+text\s+NOT\s+NULL\s+DEFAULT\s+'authored'/i.test(edges)).toBe(true);
  });

  it("constrains origin to authored rows", () => {
    expect(/CHECK\s*\(\s*origin\s+IN\s*\(\s*'authored'\s*\)\s*\)/i.test(edges)).toBe(true);
  });
});
