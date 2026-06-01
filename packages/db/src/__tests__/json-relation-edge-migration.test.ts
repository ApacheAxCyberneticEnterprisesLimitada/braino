import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const dbRoot = join(here, "..", "..");

function migration078(): string {
  const dir = join(dbRoot, "migrations");
  const name = readdirSync(dir).find((f) => /^078_materialize_json_relation_edges\.sql$/.test(f));
  if (!name) throw new Error("078_materialize_json_relation_edges.sql not found");
  return readFileSync(join(dir, name), "utf8").replace(/--[^\n]*/g, "");
}

function migration079(): string {
  const dir = join(dbRoot, "migrations");
  const name = readdirSync(dir).find((f) => /^079_edge_only_relation_json\.sql$/.test(f));
  if (!name) throw new Error("079_edge_only_relation_json.sql not found");
  return readFileSync(join(dir, name), "utf8").replace(/--[^\n]*/g, "");
}

describe("migration 078 — node JSON relation fields become edge rows", () => {
  const sql = migration078();

  it("backfills representative list and scalar relation fields as edges", () => {
    for (const [field, edgeType] of [
      ["intent_ids", "serves"],
      ["rules_consulted", "consults"],
      ["decision_ids", "enacts"],
      ["gated_by", "gated_by"],
      ["target_ref", "tests"],
      ["implemented_by", "implemented_by"],
      ["reports_to", "reports_to"],
      ["dotted_reports_to", "dotted_reports_to"],
      ["same_occupant_as", "same_occupant_as"],
    ] as const) {
      expect(sql, field).toMatch(new RegExp(`data\\s*->\\s*'${field}'`, "i"));
      expect(sql, edgeType).toMatch(new RegExp(`'${edgeType}'`, "i"));
    }
    expect(sql).toMatch(/INSERT\s+INTO\s+edges/i);
  });

  it("does not duplicate existing live edges", () => {
    expect(sql).toMatch(/NOT\s+EXISTS[\s\S]+lifecycle\s*<>\s*'retired'/i);
  });

  it("records verifiable v1 edge history", () => {
    expect(sql).toMatch(/CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+pgcrypto/i);
    expect(sql).toMatch(/INSERT\s+INTO\s+edge_versions/i);
    expect(sql).toMatch(/prev_hash,\s*this_hash/i);
    expect(sql).toMatch(/digest\([\s\S]+'sha256'/i);
  });

  it("inserts ordinary authored edge rows", () => {
    expect(sql).toMatch(/'authored'/i);
    expect(sql).not.toMatch(/'field'/i);
  });

  it("removes every relation-shaped field from node data", () => {
    for (const field of [
      "sequence_to",
      "preceded_by",
      "intent_ids",
      "decision_ids",
      "gated_by",
      "rules_consulted",
      "target_ref",
      "born_from",
      "superseded_by",
      "implemented_by",
      "reports_to",
      "dotted_reports_to",
      "same_occupant_as",
      "actor_id",
      "owner_id",
      "parent_intent_id",
      "stakeholders",
      "decided_by",
      "template_id",
      "relates_to",
    ] as const) {
      expect(sql, field).toMatch(new RegExp(`-\\s*'${field}'`, "i"));
    }
  });
});

describe("migration 079 — relation JSON keys are purged", () => {
  const sql = migration079();

  it("normalizes existing edge rows to authored origin", () => {
    expect(sql).toMatch(/UPDATE\s+edges[\s\S]+SET\s+origin\s*=\s*'authored'/i);
    expect(sql).toMatch(/CHECK\s*\(\s*origin\s+IN\s*\(\s*'authored'\s*\)\s*\)/i);
  });

  it("removes every reserved relation field name from node data", () => {
    for (const field of [
      "sequence_to",
      "preceded_by",
      "intent_ids",
      "decision_ids",
      "gated_by",
      "rules_consulted",
      "target_ref",
      "born_from",
      "superseded_by",
      "implemented_by",
      "reports_to",
      "dotted_reports_to",
      "same_occupant_as",
      "actor_id",
      "actor_principal_id",
      "actors",
      "actors_principal_ids",
      "wanted_by",
      "wanted_by_principal_id",
      "owner_id",
      "decided_by",
      "decided_by_principal_id",
      "authored_by",
      "authored_by_principal_id",
      "created_by_principal_id",
      "parent_intent_id",
      "stakeholders",
      "stakeholders_principal_ids",
      "template_id",
      "relates_to",
    ] as const) {
      expect(sql, field).toMatch(new RegExp(`-\\s*'${field}'`, "i"));
    }
  });
});
