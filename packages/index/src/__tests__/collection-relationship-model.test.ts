import { describe, expect, it, vi } from "vitest";

import {
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
        anchorId: "collection_code",
        summaries: [
          {
            collectionId: "collection_code",
            name: "Code",
            digest: "Implements checkout.",
            summaryVersion: "code-v1",
            evidenceIds: ["node:reference_checkout"],
          },
          {
            collectionId: "collection_product",
            name: "Product",
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
        goal: "",
        sources: [{ evidenceId: "node:real", title: "decision", content: "Real." }],
      }),
    ).rejects.toThrow(/evidence/i);
  });
});
