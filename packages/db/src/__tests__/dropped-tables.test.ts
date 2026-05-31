// Dead schema objects removed in migrations 071–073 — keep them gone.
//
// 071: tags, entity_fts_{users,docos,organizations}, doco_templates, and
//      perspectives.owner_user_id (unwired post-055 vestige).
// 072: doco_meta (the schema_version table is seeded once and never read) and
//      the write-only applied_migrations.applied_at timestamp.
// 073: entity_fts_policies (written by the indexer on every capture but never
//      read — the only FTS reader, Slack search, queries entity_fts_nodes
//      only; its write path was removed too).
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
  "doco_meta",
  "entity_fts_policies",
];

function declaresTable(table: string): boolean {
  return new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}\\b`, "i").test(
    schemaSql,
  );
}

function tableBlock(table: string): string {
  const re = new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}\\s*\\(([\\s\\S]*?)\\);`,
    "i",
  );
  return schemaSql.match(re)?.[1] ?? "";
}

describe("dead schema objects stay dropped (migrations 071–073)", () => {
  for (const t of DROPPED_TABLES) {
    it(`schema.sql no longer declares ${t}`, () => {
      expect(declaresTable(t)).toBe(false);
    });
  }

  it("the `tag` auxiliary entity is gone from the registry", () => {
    expect(Object.keys(ALL_ENTITY_TABLES)).not.toContain("tag");
  });

  it("perspectives no longer declares the unused owner_user_id column", () => {
    expect(/\bowner_user_id\b/.test(tableBlock("perspectives"))).toBe(false);
  });

  it("applied_migrations no longer declares the unused applied_at column", () => {
    expect(/\bapplied_at\b/.test(tableBlock("applied_migrations"))).toBe(false);
  });
});
