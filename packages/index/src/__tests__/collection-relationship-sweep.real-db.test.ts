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
    infer: vi.fn(async ({ summaries }) => {
      const code = summaries.find((summary) => summary.collectionId === "collection_code");
      const product = summaries.find((summary) => summary.collectionId === "collection_product");
      if (!code || !product) return [];
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
  it("summarizes the whole workspace before inferring one complete graph", async () => {
    await db.exec(`
      UPDATE collections
         SET data = '{"template_handle":"codebase"}'::jsonb
       WHERE id = 'collection_code';
      UPDATE collections
         SET data = '{"template_handle":"product-decisions"}'::jsonb
       WHERE id = 'collection_product';
      INSERT INTO collections (id, handle, owner_id, workspace_id, visibility, goal, data)
      VALUES (
        'collection_notion',
        'one-notion',
        'workspace_one',
        'workspace_one',
        'private',
        'Workspace documentation',
        '{"template_handle":"notion"}'::jsonb
      );
      INSERT INTO nodes (id, collection_id, node_type, lifecycle, prose, updated_at)
      VALUES (
        'reference_notion_checkout',
        'collection_notion',
        'reference',
        'active',
        'The Notion handbook documents the approved checkout architecture.',
        '2026-01-01T00:00:00Z'
      );
    `);
    const model: CollectionRelationshipModel = {
      id: "ollama:qwen3:8b",
      summarize: vi.fn(async (input) => ({
        digest: `${input.name}: ${input.sources.map((source) => source.content).join(" ")}`,
        evidenceIds: input.sources.map((source) => source.evidenceId),
      })),
      infer: vi.fn(async ({ summaries }) => {
        if (summaries.length !== 3) return [];
        const code = summaries.find((summary) => summary.collectionId === "collection_code");
        const decisions = summaries.find(
          (summary) => summary.collectionId === "collection_product",
        );
        const notion = summaries.find((summary) => summary.collectionId === "collection_notion");
        if (!code || !decisions || !notion) return [];
        const evidence = (summary: typeof code) => ({
          collectionId: summary.collectionId,
          summaryVersion: summary.summaryVersion,
          evidenceIds: [summary.evidenceIds[0]],
        });
        return [
          {
            from: decisions.collectionId,
            to: code.collectionId,
            type: "implements",
            confidence: 0.94,
            evidence: [evidence(code), evidence(decisions)],
          },
          {
            from: notion.collectionId,
            to: decisions.collectionId,
            type: "documents",
            confidence: 0.9,
            evidence: [evidence(notion), evidence(decisions)],
          },
        ];
      }),
    };

    const result = await sweepCollectionRelationships(client(), { model, limit: 10 });

    expect(result).toMatchObject({ summarized: 3, accepted: 2, rejected: 0, pending: 0 });
    expect(model.infer).toHaveBeenCalledTimes(1);
    expect(vi.mocked(model.infer).mock.calls[0]?.[0].summaries).toHaveLength(3);
    await expect(
      listCollectionRelationships(client(), {
        workspaceId: "workspace_one",
        collectionIds: ["collection_code", "collection_product", "collection_notion"],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        from: "collection_code",
        to: "collection_product",
        type: "implements",
      }),
      expect.objectContaining({
        from: "collection_notion",
        to: "collection_product",
        type: "documents",
      }),
    ]);
  });

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
      accepted: 0,
      rejected: 0,
    });
    expect(await sweepCollectionRelationships(client(), { model, limit: 1 })).toMatchObject({
      processed: 1,
      summarized: 0,
      accepted: 1,
      rejected: 0,
    });
    expect(await sweepCollectionRelationships(client(), { model, limit: 1 })).toMatchObject({
      processed: 0,
      summarized: 0,
    });

    expect(model.summarize).toHaveBeenCalledTimes(2);
    expect(model.infer).toHaveBeenCalledTimes(1);
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
      accepted: 0,
    });
    expect(await sweepCollectionRelationships(client(), { model, limit: 1 })).toMatchObject({
      processed: 1,
      summarized: 0,
      accepted: 1,
    });
    expect(model.summarize).toHaveBeenCalledTimes(3);
    expect(model.infer).toHaveBeenCalledTimes(2);
  });

  it("bounds each Qwen summary and moves past a failed collection", async () => {
    await db.exec(`
      UPDATE collections SET goal = repeat('g', 5000) WHERE id = 'collection_code';
      INSERT INTO collections (id, handle, owner_id, workspace_id, visibility, goal, data)
      VALUES (
        'collection_third', 'one-third', 'workspace_one', 'workspace_one', 'private',
        'Third collection', '{}'::jsonb
      );
      INSERT INTO nodes (id, collection_id, node_type, lifecycle, prose, updated_at)
      SELECT 'reference_' || n, 'collection_code', 'reference', 'active',
             repeat('x', 2000) || n, '2026-03-01T00:00:00Z'::timestamptz + n * interval '1 second'
        FROM generate_series(1, 20) AS n;
      INSERT INTO nodes (id, collection_id, node_type, lifecycle, prose, updated_at)
      VALUES (
        'reference_third', 'collection_third', 'reference', 'active',
        'A small third collection.', '2026-01-01T00:00:00Z'
      );
    `);
    const model = fakeModel();
    vi.mocked(model.summarize).mockImplementation(async (input) => {
      if (input.collectionId === "collection_code") throw new Error("Qwen timed out");
      return {
        digest: `${input.name}: ${input.sources.map((source) => source.content).join(" ")}`,
        evidenceIds: input.sources.map((source) => source.evidenceId),
      };
    });

    const failed = await sweepCollectionRelationships(client(), { model, limit: 3 });
    expect(failed).toMatchObject({ processed: 1, summarized: 0 });
    expect(failed.failures).toEqual([
      expect.objectContaining({ collectionId: "collection_code", error: "Qwen timed out" }),
    ]);
    const failedInput = vi.mocked(model.summarize).mock.calls[0]?.[0];
    expect(failedInput?.goal.length).toBeLessThanOrEqual(600);
    expect(failedInput?.sources.length).toBeLessThanOrEqual(8);
    expect(failedInput?.sources.every((source) => source.content.length <= 600)).toBe(true);
    expect(
      failedInput?.sources.reduce((chars, source) => chars + source.content.length, 0),
    ).toBeLessThanOrEqual(4_800);

    const next = await sweepCollectionRelationships(client(), { model, limit: 1 });
    expect(next).toMatchObject({ summarized: 1, failures: [] });
    expect(vi.mocked(model.summarize).mock.calls[1]?.[0].collectionId).not.toBe("collection_code");
  });

  it("finishes a workspace with a visible graph before newer untouched workspaces", async () => {
    await db.exec(`
      INSERT INTO workspaces (id, handle, name)
      VALUES ('workspace_two', 'two', 'Two');
      INSERT INTO collections (id, handle, owner_id, workspace_id, visibility, goal, data)
      VALUES
        ('collection_two_a', 'two-a', 'workspace_two', 'workspace_two', 'private', 'A', '{}'),
        ('collection_two_b', 'two-b', 'workspace_two', 'workspace_two', 'private', 'B', '{}');
      INSERT INTO nodes (id, collection_id, node_type, lifecycle, prose, updated_at)
      VALUES
        ('reference_two_a', 'collection_two_a', 'reference', 'active', 'Newer A.', '2027-01-01T00:00:00Z'),
        ('reference_two_b', 'collection_two_b', 'reference', 'active', 'Newer B.', '2027-01-01T00:00:00Z');
      INSERT INTO collection_relationships
        (id, workspace_id, from_collection_id, to_collection_id,
         relationship_type, confidence, evidence)
      VALUES
        ('relationship_existing', 'workspace_one', 'collection_code', 'collection_product',
         'implements', 0.9, '[]');
    `);
    const model = fakeModel();

    await sweepCollectionRelationships(client(), { model, limit: 1 });

    expect(vi.mocked(model.summarize).mock.calls[0]?.[0].collectionId).toBe("collection_code");
  });

  it("reserves batch capacity to replace a prioritized workspace graph", async () => {
    await db.exec(`
      INSERT INTO workspaces (id, handle, name)
      VALUES ('workspace_two', 'two', 'Two');
      INSERT INTO collections (id, handle, owner_id, workspace_id, visibility, goal, data)
      VALUES
        ('collection_two_a', 'two-a', 'workspace_two', 'workspace_two', 'private', 'A', '{}'),
        ('collection_two_b', 'two-b', 'workspace_two', 'workspace_two', 'private', 'B', '{}');
      INSERT INTO nodes (id, collection_id, node_type, lifecycle, prose, updated_at)
      VALUES
        ('reference_two_a', 'collection_two_a', 'reference', 'active', 'Newer A.', '2027-01-01T00:00:00Z'),
        ('reference_two_b', 'collection_two_b', 'reference', 'active', 'Newer B.', '2027-01-01T00:00:00Z');
      INSERT INTO collection_relationships
        (id, workspace_id, from_collection_id, to_collection_id,
         relationship_type, confidence, evidence)
      VALUES
        ('relationship_existing', 'workspace_one', 'collection_code', 'collection_product',
         'implements', 0.9, '[]');
    `);
    const model = fakeModel();

    const result = await sweepCollectionRelationships(client(), { model, limit: 3 });

    expect(result).toMatchObject({ processed: 3, summarized: 2, accepted: 1 });
    expect(model.summarize).toHaveBeenCalledTimes(2);
    expect(model.infer).toHaveBeenCalledTimes(1);
  });

  it("drops deterministically rejected candidates instead of storing them", async () => {
    const model = fakeModel();
    vi.mocked(model.infer).mockImplementation(async ({ summaries }) => {
      if (summaries.length < 2) return [];
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

  it("moves failed graph inference behind untouched workspaces before retrying", async () => {
    await db.exec(`
      INSERT INTO workspaces (id, handle, name)
      VALUES ('workspace_two', 'two', 'Two');
      INSERT INTO collections (id, handle, owner_id, workspace_id, visibility, goal, data)
      VALUES
        ('collection_two_a', 'two-a', 'workspace_two', 'workspace_two', 'private', 'A', '{}'),
        ('collection_two_b', 'two-b', 'workspace_two', 'workspace_two', 'private', 'B', '{}');
      INSERT INTO nodes (id, collection_id, node_type, lifecycle, prose, updated_at)
      VALUES
        ('reference_two_a', 'collection_two_a', 'reference', 'active', 'Two A.', '2026-01-01T00:00:00Z'),
        ('reference_two_b', 'collection_two_b', 'reference', 'active', 'Two B.', '2026-01-01T00:00:00Z');
    `);
    const model = fakeModel();
    vi.mocked(model.infer)
      .mockRejectedValueOnce(new Error("Qwen unavailable"))
      .mockResolvedValue([]);

    const failed = await sweepCollectionRelationships(client(), { model, limit: 3 });
    expect(failed.failures).toEqual([
      expect.objectContaining({ collectionId: "workspace_one", error: "Qwen unavailable" }),
    ]);
    const rotated = await sweepCollectionRelationships(client(), { model, limit: 3 });
    expect(rotated).toMatchObject({ processed: 3, summarized: 2, failures: [] });
    expect(vi.mocked(model.infer).mock.calls[1]?.[0].summaries[0]?.collectionId).toBe(
      "collection_two_a",
    );
    const retried = await sweepCollectionRelationships(client(), { model, limit: 1 });
    expect(retried).toMatchObject({ processed: 1, summarized: 0, failures: [] });
    expect(vi.mocked(model.infer).mock.calls[2]?.[0].summaries[0]?.collectionId).toBe(
      "collection_code",
    );
    expect(model.summarize).toHaveBeenCalledTimes(4);
    expect(model.infer).toHaveBeenCalledTimes(3);
  });
});
