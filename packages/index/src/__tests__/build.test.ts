import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { reindex } from "../build.js";
import { openDb } from "../db.js";

const REPO_ROOT = resolve(__dirname, "../../../..");

describe("reindex against the Doco project", () => {
  it("rebuilds the cache and inserts every entity", async () => {
    const report = await reindex(REPO_ROOT);
    // 78 entities + 1 doco root = 79
    expect(report.inserted).toBeGreaterThanOrEqual(70);
    expect(report.durationMs).toBeLessThan(5_000);
  });

  it("indexed tables contain expected counts", async () => {
    await reindex(REPO_ROOT);
    const db = await openDb(REPO_ROOT, { readonly: true, fileMustExist: true });
    try {
      // Principal/Organization tables removed by ADR-087 (local-solo collapse).
      const counts = {
        intent: (db.prepare("SELECT COUNT(*) as n FROM intent").get() as { n: number }).n,
        idea: (db.prepare("SELECT COUNT(*) as n FROM idea").get() as { n: number }).n,
        rule: (db.prepare("SELECT COUNT(*) as n FROM rule").get() as { n: number }).n,
        decision: (db.prepare("SELECT COUNT(*) as n FROM decision").get() as { n: number }).n,
        action: (db.prepare("SELECT COUNT(*) as n FROM action").get() as { n: number }).n,
        reasoning: (db.prepare("SELECT COUNT(*) as n FROM reasoning").get() as { n: number }).n,
        reference: (db.prepare("SELECT COUNT(*) as n FROM reference").get() as { n: number }).n,
        scope: (db.prepare("SELECT COUNT(*) as n FROM scope").get() as { n: number }).n,
      };
      expect(counts.intent).toBe(7);
      expect(counts.idea).toBeGreaterThanOrEqual(1);
      expect(counts.rule).toBe(8);
      expect(counts.decision).toBeGreaterThanOrEqual(86);
      expect(counts.action).toBeGreaterThanOrEqual(50);
      expect(counts.reasoning).toBeGreaterThanOrEqual(2);
      expect(counts.reference).toBe(3);
      expect(counts.scope).toBe(6);
    } finally {
      db.close();
    }
  });

  it("derives edges (decision serves intent) for at least one decision", async () => {
    await reindex(REPO_ROOT);
    const db = await openDb(REPO_ROOT, { readonly: true, fileMustExist: true });
    try {
      const servingEdges = db
        .prepare(
          "SELECT COUNT(*) as n FROM edges WHERE edge_type = 'serves' AND from_node_type = 'decision'",
        )
        .get() as { n: number };
      expect(servingEdges.n).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("supports FTS5 search over summary", async () => {
    await reindex(REPO_ROOT);
    const db = await openDb(REPO_ROOT, { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare("SELECT id FROM fts WHERE fts MATCH 'priority' ORDER BY rank LIMIT 5")
        .all() as { id: string }[];
      expect(rows.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("one-hop query: which decisions serve a given intent? completes in <10ms", async () => {
    await reindex(REPO_ROOT);
    const db = await openDb(REPO_ROOT, { readonly: true, fileMustExist: true });
    try {
      const stmt = db.prepare(
        "SELECT from_id FROM edges WHERE edge_type = 'serves' AND to_id = ?",
      );
      const intentId = "intent_01KR441EAEM5NQBM160763TDDT"; // implementation-v0
      const start = performance.now();
      const rows = stmt.all(intentId) as { from_id: string }[];
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(10);
      expect(rows.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
