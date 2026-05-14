import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { reindex } from "../build.js";
import { openDb } from "../db.js";
import type { EmbeddingProviderLike } from "../embeddings.js";

const REPO_ROOT = resolve(__dirname, "../../../../docos/torrenegra/doco");

/**
 * Deterministic mock provider so the double-reindex test runs offline.
 * Returns a fixed-dim vector that's a hash of the input — same input
 * always maps to the same vector, so content-hash gating can do its job.
 */
class MockEmbeddingProvider implements EmbeddingProviderLike {
  modelId = "mock:reindex-fixed-4d";
  dimensions = 4;
  public calls: string[][] = [];
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls.push(texts);
    return texts.map((t) => {
      const v = new Float32Array(this.dimensions);
      for (let i = 0; i < t.length; i++) {
        v[i % this.dimensions] += t.charCodeAt(i) / 255;
      }
      return v;
    });
  }
}

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
      const counts = {
        principal: (db.prepare("SELECT COUNT(*) as n FROM principal").get() as { n: number }).n,
        intent: (db.prepare("SELECT COUNT(*) as n FROM intent").get() as { n: number }).n,
        idea: (db.prepare("SELECT COUNT(*) as n FROM idea").get() as { n: number }).n,
        rule: (db.prepare("SELECT COUNT(*) as n FROM rule").get() as { n: number }).n,
        decision: (db.prepare("SELECT COUNT(*) as n FROM decision").get() as { n: number }).n,
        action: (db.prepare("SELECT COUNT(*) as n FROM action").get() as { n: number }).n,
        reasoning: (db.prepare("SELECT COUNT(*) as n FROM reasoning").get() as { n: number }).n,
        reference: (db.prepare("SELECT COUNT(*) as n FROM reference").get() as { n: number }).n,
        scope: (db.prepare("SELECT COUNT(*) as n FROM scope").get() as { n: number }).n,
      };
      expect(counts.principal).toBeGreaterThanOrEqual(2);
      expect(counts.intent).toBeGreaterThanOrEqual(7);
      expect(counts.idea).toBeGreaterThanOrEqual(1);
      expect(counts.rule).toBeGreaterThanOrEqual(8);
      expect(counts.decision).toBeGreaterThanOrEqual(85);
      expect(counts.action).toBeGreaterThanOrEqual(50);
      expect(counts.reasoning).toBeGreaterThanOrEqual(2);
      expect(counts.reference).toBeGreaterThanOrEqual(3);
      expect(counts.scope).toBeGreaterThanOrEqual(1);
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

  it("preserves embeddings across reindex runs; second run is a no-op for the provider", async () => {
    // Run 1 establishes the baseline. We don't care whether it computed
    // or skipped — it depends on whether a previous run already wrote
    // mock-provider rows. What matters is that run 2 sees the same set
    // as the union of run 1's computed + skipped, and skips all of it.
    const provider = new MockEmbeddingProvider();
    const r1 = await reindex(REPO_ROOT, { embeddingProvider: provider });
    expect(r1.embeddings).toBeDefined();
    const r1Total = (r1.embeddings?.computed ?? 0) + (r1.embeddings?.skipped ?? 0);
    expect(r1Total).toBeGreaterThan(0);

    // Snapshot the row counts that should NOT grow on the next run.
    const dbAfter1 = await openDb(REPO_ROOT, { readonly: true, fileMustExist: true });
    const ftsBefore = (
      dbAfter1.prepare("SELECT COUNT(*) AS n FROM fts").get() as { n: number }
    ).n;
    const edgesBefore = (
      dbAfter1.prepare("SELECT COUNT(*) AS n FROM edges").get() as { n: number }
    ).n;
    const embeddingsBefore = (
      dbAfter1.prepare("SELECT COUNT(*) AS n FROM embeddings").get() as { n: number }
    ).n;
    dbAfter1.close();

    // Run 2: same source files, same provider. Content-hash gate should
    // skip every entity, embeddings table should be preserved, and the
    // mutable tables (fts/edges) should be cleared + repopulated without
    // duplicates.
    const callsBefore = provider.calls.length;
    const r2 = await reindex(REPO_ROOT, { embeddingProvider: provider });
    expect(r2.embeddings?.computed).toBe(0);
    expect(r2.embeddings?.skipped).toBe(r1Total);
    expect(r2.embeddings?.pruned).toBe(0);
    expect(provider.calls.length).toBe(callsBefore); // no new provider call

    const dbAfter2 = await openDb(REPO_ROOT, { readonly: true, fileMustExist: true });
    try {
      const ftsAfter = (
        dbAfter2.prepare("SELECT COUNT(*) AS n FROM fts").get() as { n: number }
      ).n;
      const edgesAfter = (
        dbAfter2.prepare("SELECT COUNT(*) AS n FROM edges").get() as { n: number }
      ).n;
      const embeddingsAfter = (
        dbAfter2.prepare("SELECT COUNT(*) AS n FROM embeddings").get() as { n: number }
      ).n;

      // No duplicate fts rows — counts identical between runs.
      expect(ftsAfter).toBe(ftsBefore);

      // No duplicate edge rows.
      expect(edgesAfter).toBe(edgesBefore);

      // Embeddings table preserved (not wiped + re-embedded).
      expect(embeddingsAfter).toBe(embeddingsBefore);
    } finally {
      dbAfter2.close();
    }

    // With a real provider, the time saving is one provider round-trip
    // (≈1–10s on OpenAI). With the mock provider both runs are fast, so
    // we only assert the second run is at least as quick — a regression
    // here means the truncate is leaking work.
    expect(r2.durationMs).toBeLessThanOrEqual(r1.durationMs + 250);
  });
});
