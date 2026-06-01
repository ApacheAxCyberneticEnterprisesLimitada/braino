import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const dbRoot = join(here, "..", "..");

function migration077(): string {
  const dir = join(dbRoot, "migrations");
  const name = readdirSync(dir).find((f) => /^077_materialize_bpmn_sequence_edges\.sql$/.test(f));
  if (!name) throw new Error("077_materialize_bpmn_sequence_edges.sql not found");
  return readFileSync(join(dir, name), "utf8").replace(/--[^\n]*/g, "");
}

describe("migration 077 — BPMN flow fields become edge rows", () => {
  const sql = migration077();

  it("backfills sequence_to JSON as sequence_flow edges", () => {
    expect(sql).toMatch(/data\s*->\s*'sequence_to'/i);
    expect(sql).toMatch(/'sequence_flow'/i);
    expect(sql).toMatch(/INSERT\s+INTO\s+edges/i);
  });

  it("backfills preceded_by JSON as preceded_by edges", () => {
    expect(sql).toMatch(/data\s*->\s*'preceded_by'/i);
    expect(sql).toMatch(/'preceded_by'/i);
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

  it("removes legacy flow fields from node data", () => {
    expect(sql).toMatch(/UPDATE\s+nodes[\s\S]+data\s*=[\s\S]+-\s*'sequence_to'/i);
    expect(sql).toMatch(/data\s*=[\s\S]+-\s*'preceded_by'/i);
  });
});
