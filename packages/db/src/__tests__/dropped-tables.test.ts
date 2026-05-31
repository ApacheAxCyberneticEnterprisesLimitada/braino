// Dead schema objects removed in migration 071 — keep them gone.
//
// tags, entity_fts_{users,docos,organizations}, and doco_templates had no
// read or write path anywhere in the codebase; perspectives.owner_user_id
// was an unwired post-055 vestige (owner_handle is the live owner ref).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_ENTITY_TABLES } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

const DROPPED_TABLES = [
  "tags",
  "entity_fts_users",
  "entity_fts_docos",
  "entity_fts_organizations",
  "doco_templates",
];

function declaresTable(table: string): boolean {
  return new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}\\b`, "i").test(
    schemaSql,
  );
}

function perspectivesBlock(): string {
  return (
    schemaSql.match(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?perspectives\s*\(([\s\S]*?)\);/i,
    )?.[1] ?? ""
  );
}

describe("dead schema objects stay dropped (migration 071)", () => {
  for (const t of DROPPED_TABLES) {
    it(`schema.sql no longer declares ${t}`, () => {
      expect(declaresTable(t)).toBe(false);
    });
  }

  it("the `tag` auxiliary entity is gone from the registry", () => {
    expect(Object.keys(ALL_ENTITY_TABLES)).not.toContain("tag");
  });

  it("perspectives no longer declares the unused owner_user_id column", () => {
    expect(/\bowner_user_id\b/.test(perspectivesBlock())).toBe(false);
  });
});
