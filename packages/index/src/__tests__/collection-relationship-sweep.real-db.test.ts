import type { QueryClient } from "@doco/db";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import type { CollectionRelationshipModel } from "../collection-relationship-model.js";
import { listCollectionRelationships } from "../collection-relationship-store.js";
import { sweepCollectionRelationships } from "../collection-relationship-sweep.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
  await db.exec(`
    INSERT INTO workspaces (id, handle, name)
    VALUES ('workspace_one', 'one', 'One');
    INSERT INTO collections (id, handle, owner_id, workspace_id, visibility, goal, data)
    VALUES
      ('collection_code', 'one-code', 'workspace_one', 'workspace_one', 'private', 'The implementation', '{}'::jsonb),
      ('collection_product', 'one-product', 'workspace_one', 'workspace_one', 'private', 'Product decisions', '{}'::jsonb);
    INSERT INTO nodes (id, collection_id, node_type, lifecycle, prose, updated_at)
    VALUES
      ('reference_checkout', 'collection_code', 'reference', 'active', 'The application implements checkout.', '2026-01-01T00:00:00Z'),
      ('decision_checkout', 'collection_product', 'decision', 'active', 'The product requires checkout.', '2026-01-01T00:00:00Z');
  `);
});

const client = () => db as unknown as QueryClient;

function fakeModel(): CollectionRelationshipModel {
  return {
    id: "ollama:qwen3:8b",
    summarize: vi.fn(async (input) => ({
      digest: `${input.name}: ${input.sources.map((source) => source.content).join(" ")}`,
      evidenceIds: input.sources.map((source) => source.evidenceId),
    })),
    infer: vi.fn(async ({ anchorId, summaries }) => {
      const code = summaries.find((summary) => summary.collectionId === "collection_code");
      const product = summaries.find((summary) => summary.collectionId === "collection_product");
      if (!code || !product || anchorId !== "collection_product") return [];
      return [
        {
          from: "collection_code",
          to: "collection_product",
          type: "implements",
          confidence: 0.94,
          evidence: [
            {
              collectionId: code.collectionId,
              summaryVersion: code.summaryVersion,
              evidenceIds: [code.evidenceIds[0]],
            },
            {
              collectionId: product.collectionId,
              summaryVersion: product.summaryVersion,
              evidenceIds: [product.evidenceIds[0]],
            },
          ],
        },
      ];
    }),
  };
}

describe("collection relationship sweep", () => {
  it("summarizes changed collections, validates Qwen output, and makes unchanged runs free", async () => {
    const model = fakeModel();

    expect(await sweepCollectionRelationships(client(), { model, limit: 1 })).toMatchObject({
      processed: 1,
      summarized: 1,
      accepted: 0,
    });
    expect(await sweepCollectionRelationships(client(), { model, limit: 1 })).toMatchObject({
      processed: 1,
      summarized: 1,
      accepted: 1,
      rejected: 0,
    });
    expect(await sweepCollectionRelationships(client(), { model, limit: 1 })).toMatchObject({
      processed: 0,
      summarized: 0,
    });

    expect(model.summarize).toHaveBeenCalledTimes(2);
    expect(model.infer).toHaveBeenCalledTimes(2);
    await expect(
      listCollectionRelationships(client(), {
        workspaceId: "workspace_one",
        collectionIds: ["collection_code", "collection_product"],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        from: "collection_code",
        to: "collection_product",
        type: "implements",
        confidence: 0.94,
      }),
    ]);

    await db.exec(`
      UPDATE nodes
         SET prose = 'The product requires checkout and refunds.',
             updated_at = '2026-02-01T00:00:00Z'
       WHERE id = 'decision_checkout'
    `);
    expect(await sweepCollectionRelationships(client(), { model, limit: 1 })).toMatchObject({
      processed: 1,
      summarized: 1,
      accepted: 1,
    });
    expect(model.summarize).toHaveBeenCalledTimes(3);
  });

  it("drops deterministically rejected candidates instead of storing them", async () => {
    const model = fakeModel();
    vi.mocked(model.infer).mockImplementation(async ({ anchorId, summaries }) => {
      if (summaries.length < 2 || anchorId !== "collection_product") return [];
      const code = summaries.find((summary) => summary.collectionId === "collection_code");
      const product = summaries.find((summary) => summary.collectionId === "collection_product");
      if (!code || !product) return [];
      return [
        {
          from: code.collectionId,
          to: product.collectionId,
          type: "implements",
          confidence: 0.99,
          evidence: [
            {
              collectionId: code.collectionId,
              summaryVersion: code.summaryVersion,
              evidenceIds: ["node:invented"],
            },
            {
              collectionId: product.collectionId,
              summaryVersion: product.summaryVersion,
              evidenceIds: [product.evidenceIds[0]],
            },
          ],
        },
      ];
    });

    await sweepCollectionRelationships(client(), { model, limit: 1 });
    const result = await sweepCollectionRelationships(client(), { model, limit: 1 });
    expect(result).toMatchObject({ accepted: 0, rejected: 1 });
    await expect(
      listCollectionRelationships(client(), {
        workspaceId: "workspace_one",
        collectionIds: ["collection_code", "collection_product"],
      }),
    ).resolves.toEqual([]);
  });

  it("retries inference after failure without summarizing unchanged evidence twice", async () => {
    await db.exec("DELETE FROM collections WHERE id = 'collection_product'");
    const model = fakeModel();
    vi.mocked(model.infer)
      .mockRejectedValueOnce(new Error("Qwen unavailable"))
      .mockResolvedValueOnce([]);

    const failed = await sweepCollectionRelationships(client(), { model, limit: 1 });
    expect(failed.failures).toEqual([
      expect.objectContaining({ collectionId: "collection_code", error: "Qwen unavailable" }),
    ]);
    const retried = await sweepCollectionRelationships(client(), { model, limit: 1 });
    expect(retried).toMatchObject({ processed: 1, summarized: 0, failures: [] });
    expect(model.summarize).toHaveBeenCalledTimes(1);
    expect(model.infer).toHaveBeenCalledTimes(2);
  });
});
