import type { QueryClient } from "@doco/db";
import { describe, expect, it, vi } from "vitest";
import { backfillEmbeddingsToVectorStore, parsePgVector } from "../qdrant-backfill.js";
import type { VectorStore } from "../qdrant-vector-store.js";

describe("Qdrant embedding backfill", () => {
  it("parses pgvector's text representation", () => {
    expect(parsePgVector("[1,-0.25,3e-2]")).toEqual([1, -0.25, 0.03]);
    expect(() => parsePgVector("not-a-vector")).toThrow("Invalid pgvector value");
  });

  it("copies every PostgreSQL row in bounded batches", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            collection_id: "collection_alpha",
            source: "node",
            entity_id: "decision_alpha",
            chunk_index: 0,
            model_id: "test:model",
            content_hash: "hash-a",
            chunk_text: "Alpha",
            embedding: "[1,0]",
          },
          {
            collection_id: "collection_alpha",
            source: "node",
            entity_id: "decision_beta",
            chunk_index: 0,
            model_id: "test:model",
            content_hash: "hash-b",
            chunk_text: "Beta",
            embedding: "[0,1]",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const upsert = vi.fn(async () => undefined);

    const report = await backfillEmbeddingsToVectorStore(
      { query } as unknown as QueryClient,
      { upsert } as unknown as VectorStore,
      { batchSize: 2, collectionIds: ["collection_alpha"] },
    );

    expect(report).toEqual({ rows: 2, batches: 1 });
    expect(upsert).toHaveBeenCalledWith([
      expect.objectContaining({ entity_id: "decision_alpha", embedding: [1, 0] }),
      expect.objectContaining({ entity_id: "decision_beta", embedding: [0, 1] }),
    ]);
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("(collection_id, entity_id, chunk_index) > ($2, $3, $4)"),
      [["collection_alpha"], "collection_alpha", "decision_beta", 0, 2],
    );
  });
});
