import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const dbRoot = join(here, "..", "..");

function migration079(): string {
  const dir = join(dbRoot, "migrations");
  const name = readdirSync(dir).find((f) => /^079_simplify_edge_types_reset\.sql$/.test(f));
  if (!name) throw new Error("079_simplify_edge_types_reset.sql not found");
  return readFileSync(join(dir, name), "utf8");
}

describe("migration 079 - simplify edge types reset", () => {
  const sql = migration079();

  it("documents the full wipe behind the simplified edge vocabulary", () => {
    expect(sql).toMatch(/FULL WIPE/i);
    expect(sql).toMatch(/simplif(?:y|ied) edge/i);
  });

  it("drops every public table except the migration ledger", () => {
    expect(sql).toMatch(/pg_tables/i);
    expect(sql).toMatch(/schemaname\s*=\s*'public'/i);
    expect(sql).toMatch(/tablename\s*<>\s*'applied_migrations'/i);
    expect(sql).toMatch(/DROP\s+TABLE\s+IF\s+EXISTS\s+public\.%I\s+CASCADE/i);
  });
});
