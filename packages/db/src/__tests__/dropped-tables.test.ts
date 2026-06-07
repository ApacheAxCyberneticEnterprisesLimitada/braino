// Dead schema objects stay out of the current baseline.
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
  "entity_fts_workspaces",
  "doco_templates",
  "doco_meta",
  "entity_fts_policies",
  // Collapsed into the single `policies` table.
  "guidance_policies",
  "node_authoring_policies",
  // The live "all my workspaces" person-to-person delegation was retired; that
  // breadth now lives only on tokens. Grants to people name concrete targets.
  "account_grants",
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

describe("dead schema objects stay dropped", () => {
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

  it("docos no longer declares the write-only allowed_node_types column", () => {
    // The Doco-level node-type allowlist was seeded at creation but never
    // read by any capture-time check, and the lone template that set it
    // (`global`) pointed at the removed `guidance_policy` /
    // `node_authoring_policy` types. Column dropped with the policy unify.
    expect(/\ballowed_node_types\b/.test(tableBlock("docos"))).toBe(false);
  });

  it("does not keep a migration ledger table in the baseline", () => {
    expect(declaresTable("applied_migrations")).toBe(false);
  });
});
