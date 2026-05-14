import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  blobToEmbedding,
  computeContentHash,
  cosineSimilarity,
  embeddingToBlob,
  getEmbeddings,
  getEmbeddingsByNodeType,
  upsertEmbeddings,
  type EmbeddingProviderLike,
} from "../embeddings.js";
import { migrate } from "../migrate.js";

function freshDb() {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

// Mock provider — returns a deterministic embedding per input text so we
// can assert on stored vectors without hitting a real API.
class MockProvider implements EmbeddingProviderLike {
  modelId = "mock:fixed-4d";
  dimensions = 4;
  public calls: string[][] = [];
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls.push(texts);
    return texts.map((t) => {
      // Cheap deterministic mapping: char-code rolling sum into 4 buckets.
      const v = new Float32Array(this.dimensions);
      for (let i = 0; i < t.length; i++) {
        v[i % this.dimensions] += t.charCodeAt(i) / 255;
      }
      return v;
    });
  }
}

describe("computeContentHash", () => {
  it("is stable across runs and sensitive to inputs", () => {
    const a = computeContentHash("hello", "world");
    const b = computeContentHash("hello", "world");
    const c = computeContentHash("hello", "worlds");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const v = new Float32Array([1, 2, 3, 4]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 6);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(
      cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1])),
    ).toBeCloseTo(0, 6);
  });

  it("returns 0 when either side is the zero vector", () => {
    expect(
      cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1])),
    ).toBe(0);
  });
});

describe("embeddingToBlob / blobToEmbedding", () => {
  it("roundtrips floats losslessly", () => {
    const orig = new Float32Array([0.1, -0.5, 3.14, 1e-6]);
    const buf = embeddingToBlob(orig);
    const back = blobToEmbedding(buf);
    expect(back.length).toBe(orig.length);
    for (let i = 0; i < orig.length; i++) {
      expect(back[i]).toBeCloseTo(orig[i], 6);
    }
  });
});

describe("upsertEmbeddings", () => {
  it("computes embeddings for new rows and skips unchanged ones", async () => {
    const db = freshDb();
    const provider = new MockProvider();
    const inputs = [
      {
        entity_id: "decision_aaa",
        doco_id: "doco_x",
        text: "alpha",
        content_hash: computeContentHash("alpha", ""),
      },
      {
        entity_id: "decision_bbb",
        doco_id: "doco_x",
        text: "beta",
        content_hash: computeContentHash("beta", ""),
      },
    ];

    const r1 = await upsertEmbeddings(db, inputs, provider);
    expect(r1.computed).toBe(2);
    expect(r1.skipped).toBe(0);
    expect(provider.calls.length).toBe(1);

    const r2 = await upsertEmbeddings(db, inputs, provider);
    expect(r2.computed).toBe(0);
    expect(r2.skipped).toBe(2);
    expect(provider.calls.length).toBe(1);

    db.close();
  });

  it("re-embeds when content_hash changes", async () => {
    const db = freshDb();
    const provider = new MockProvider();
    await upsertEmbeddings(
      db,
      [
        {
          entity_id: "rule_1",
          doco_id: "doco_x",
          text: "first",
          content_hash: "h1",
        },
      ],
      provider,
    );
    const r = await upsertEmbeddings(
      db,
      [
        {
          entity_id: "rule_1",
          doco_id: "doco_x",
          text: "second",
          content_hash: "h2",
        },
      ],
      provider,
    );
    expect(r.computed).toBe(1);
    expect(r.skipped).toBe(0);
    db.close();
  });

  it("re-embeds when model_id changes", async () => {
    const db = freshDb();
    const text = "fixed text";
    const hash = computeContentHash(text, "");
    await upsertEmbeddings(
      db,
      [{ entity_id: "rule_1", doco_id: "doco_x", text, content_hash: hash }],
      new MockProvider(),
    );

    class OtherProvider extends MockProvider {
      override modelId = "mock:fixed-4d-v2";
    }
    const other = new OtherProvider();
    const r = await upsertEmbeddings(
      db,
      [{ entity_id: "rule_1", doco_id: "doco_x", text, content_hash: hash }],
      other,
    );
    expect(r.computed).toBe(1);
    expect(r.skipped).toBe(0);
    db.close();
  });

  it("skips empty-text entries entirely", async () => {
    const db = freshDb();
    const provider = new MockProvider();
    const r = await upsertEmbeddings(
      db,
      [
        {
          entity_id: "rule_empty",
          doco_id: "doco_x",
          text: "   ",
          content_hash: "h",
        },
      ],
      provider,
    );
    expect(r.computed).toBe(0);
    expect(r.skipped).toBe(0);
    expect(provider.calls.length).toBe(0);
    db.close();
  });
});

describe("getEmbeddings", () => {
  it("returns a map keyed by entity_id, omitting ids without rows", async () => {
    const db = freshDb();
    const provider = new MockProvider();
    await upsertEmbeddings(
      db,
      [
        {
          entity_id: "a",
          doco_id: "doco_x",
          text: "alpha",
          content_hash: "ha",
        },
        {
          entity_id: "b",
          doco_id: "doco_x",
          text: "beta",
          content_hash: "hb",
        },
      ],
      provider,
    );
    const m = getEmbeddings(db, ["a", "b", "c"]);
    expect(m.size).toBe(2);
    expect(m.get("a")?.length).toBe(provider.dimensions);
    expect(m.get("c")).toBeUndefined();
    db.close();
  });

  it("returns an empty map for an empty id list (no SQL run)", () => {
    const db = freshDb();
    expect(getEmbeddings(db, []).size).toBe(0);
    db.close();
  });
});

describe("getEmbeddingsByNodeType", () => {
  it("joins against the per-type table so it only returns rules", async () => {
    const db = freshDb();
    // Seed one rule row and one decision row so we have something to join.
    db.prepare(
      `INSERT INTO rule (id, doco_id, summary, modality, phase, created_at, created_by, raw_json)
       VALUES (?, ?, ?, 'must', 'capture', ?, ?, '{}')`,
    ).run("rule_1", "doco_x", "first rule", "2026-01-01", "principal_x");
    db.prepare(
      `INSERT INTO decision (id, doco_id, summary, question, decided_by, decided_at, created_at, created_by, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
    ).run(
      "decision_1",
      "doco_x",
      "first decision",
      "why?",
      "principal_x",
      "2026-01-01",
      "2026-01-01",
      "principal_x",
    );

    const provider = new MockProvider();
    await upsertEmbeddings(
      db,
      [
        {
          entity_id: "rule_1",
          doco_id: "doco_x",
          text: "rule text",
          content_hash: "h1",
        },
        {
          entity_id: "decision_1",
          doco_id: "doco_x",
          text: "decision text",
          content_hash: "h2",
        },
      ],
      provider,
    );

    const rules = getEmbeddingsByNodeType(db, "rule");
    expect(rules.length).toBe(1);
    expect(rules[0].entity_id).toBe("rule_1");

    const decisions = getEmbeddingsByNodeType(db, "decision");
    expect(decisions.length).toBe(1);
    expect(decisions[0].entity_id).toBe("decision_1");

    db.close();
  });
});
