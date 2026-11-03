import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_COLLECTION_RELATIONSHIP_TIMEOUT_MS,
  OllamaCollectionRelationshipModel,
  configuredCollectionRelationshipModel,
} from "../collection-relationship-model.js";

function ollamaResponse(content: unknown): Response {
  return Response.json({
    message: { content: JSON.stringify(content) },
    prompt_eval_count: 12,
    eval_count: 7,
  });
}

describe("Ollama collection relationship model", () => {
  it("finishes a model request before the serverless function deadline", () => {
    expect(DEFAULT_COLLECTION_RELATIONSHIP_TIMEOUT_MS).toBe(180_000);
  });

  it("is disabled unless the shared graph model is configured", () => {
    expect(configuredCollectionRelationshipModel({})).toBeNull();
  });

  it("summarizes evidence and infers relationships through deterministic Qwen requests", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        ollamaResponse({
          digest: "Implements checkout from the product plan.",
          evidenceIds: ["node:decision_checkout"],
        }),
      )
      .mockResolvedValueOnce(
        ollamaResponse({
          relationships: [
            {
              from: "collection_code",
              to: "collection_product",
              type: "implements",
              confidence: 0.94,
              evidence: [
                {
                  collectionId: "collection_code",
                  summaryVersion: "code-v1",
                  evidenceIds: ["node:reference_checkout"],
                },
                {
                  collectionId: "collection_product",
                  summaryVersion: "product-v1",
                  evidenceIds: ["node:decision_checkout"],
                },
              ],
            },
          ],
        }),
      );
    const model = new OllamaCollectionRelationshipModel({
      model: "qwen3:8b",
      url: "https://qwen.test/api/chat",
      apiToken: "secret",
      fetchImpl,
    });

    await expect(
      model.summarize({
        collectionId: "collection_product",
        name: "Product",
        kind: "product-decisions",
        goal: "Product decisions",
        sources: [
          {
            evidenceId: "node:decision_checkout",
            title: "decision",
            content: "The product requires checkout.",
          },
        ],
      }),
    ).resolves.toEqual({
      digest: "Implements checkout from the product plan.",
      evidenceIds: ["node:decision_checkout"],
    });

    await expect(
      model.infer({
        summaries: [
          {
            collectionId: "collection_code",
            name: "Code",
            kind: "codebase",
            digest: "Implements checkout.",
            summaryVersion: "code-v1",
            evidenceIds: ["node:reference_checkout"],
          },
          {
            collectionId: "collection_product",
            name: "Product",
            kind: "product-decisions",
            digest: "Defines checkout.",
            summaryVersion: "product-v1",
            evidenceIds: ["node:decision_checkout"],
          },
        ],
      }),
    ).resolves.toHaveLength(1);

    expect(model.id).toBe("ollama:qwen3:8b");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const request = fetchImpl.mock.calls[0]?.[1];
    expect(request?.headers).toEqual({
      authorization: "Bearer secret",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(request?.body))).toMatchObject({
      model: "qwen3:8b",
      stream: false,
      think: false,
      options: { temperature: 0, seed: 42 },
    });
    const summaryRequest = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(summaryRequest.options).toMatchObject({ num_ctx: 4_096, num_predict: 384 });
    expect(summaryRequest.format.properties.evidenceIds.items.enum).toEqual([
      "node:decision_checkout",
    ]);
    expect(summaryRequest.messages[1].content).toContain('"kind":"product-decisions"');
    expect(summaryRequest.messages[1].content).toContain("Preserve concrete overlap");
    const relationshipRequest = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(relationshipRequest.options).toMatchObject({ num_ctx: 8_192, num_predict: 2_048 });
    expect(relationshipRequest.messages[0].content).toContain("every unordered pair");
    expect(relationshipRequest.messages[1].content).toContain("Evaluate every unordered pair");
    expect(relationshipRequest.messages[1].content).toContain(
      "A codebase can implement architectural decisions",
    );
    expect(relationshipRequest.format.properties.relationships.items.properties.from.enum).toEqual([
      "collection_code",
      "collection_product",
    ]);
    expect(
      relationshipRequest.format.properties.relationships.items.properties.evidence.items.properties
        .collectionId.enum,
    ).toEqual(["collection_code", "collection_product"]);
  });

  it("rejects summary evidence the model was not shown", async () => {
    const model = new OllamaCollectionRelationshipModel({
      fetchImpl: vi.fn(async () =>
        ollamaResponse({ digest: "Invented.", evidenceIds: ["node:not-supplied"] }),
      ),
    });
    await expect(
      model.summarize({
        collectionId: "collection_one",
        name: "One",
        kind: "generic",
        goal: "",
        sources: [{ evidenceId: "node:real", title: "decision", content: "Real." }],
      }),
    ).rejects.toThrow(/evidence/i);
  });
});
