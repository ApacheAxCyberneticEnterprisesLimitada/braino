import { describe, expect, it, vi } from "vitest";

import {
  COLLECTION_RELATIONSHIP_PIPELINE_VERSION,
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

  it("invalidates stored summaries when the semantic-summary contract changes", () => {
    expect(COLLECTION_RELATIONSHIP_PIPELINE_VERSION).toBe("workspace-graph-v4-semantic-summaries");
  });

  it("is disabled unless the shared graph model is configured", () => {
    expect(configuredCollectionRelationshipModel({})).toBeNull();
  });

  it("summarizes evidence and infers relationships through deterministic Qwen requests", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        ollamaResponse({
          digest:
            "The collection defines checkout through the payment service and confirms orders only after payment succeeds.",
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
      digest:
        "The collection defines checkout through the payment service and confirms orders only after payment succeeds.",
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
    ).resolves.toEqual([
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
    ]);

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
    expect(summaryRequest.options).toMatchObject({ num_ctx: 4_096, num_predict: 640 });
    expect(summaryRequest.format.properties.evidenceIds.items.enum).toEqual([
      "node:decision_checkout",
    ]);
    expect(summaryRequest.format.properties.digest).toMatchObject({ minLength: 80 });
    expect(summaryRequest.messages[1].content).toContain('"kind":"product-decisions"');
    expect(summaryRequest.messages[1].content).toContain("Preserve concrete overlap");
    expect(summaryRequest.messages[1].content).toContain("Never return only a collection name");
    const relationshipRequest = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(relationshipRequest.options).toMatchObject({ num_ctx: 8_192, num_predict: 768 });
    expect(relationshipRequest.messages[0].content).toContain("every unordered pair");
    expect(relationshipRequest.messages[1].content).toContain("Evaluate every unordered pair");
    expect(relationshipRequest.messages[1].content).toContain(
      "A codebase can implement architectural decisions",
    );
    expect(relationshipRequest.messages[1].content).toContain(
      "Return at most 5 strongest relationships",
    );
    expect(relationshipRequest.messages[1].content).toContain(
      "Return only from, to, type, and confidence",
    );
    expect(relationshipRequest.format.properties.relationships.maxItems).toBe(5);
    expect(relationshipRequest.format.properties.relationships.items.properties.from.enum).toEqual([
      "collection_code",
      "collection_product",
    ]);
    expect(relationshipRequest.format.properties.relationships.items.required).toEqual([
      "from",
      "to",
      "type",
      "confidence",
    ]);
    expect(
      relationshipRequest.format.properties.relationships.items.properties.evidence,
    ).toBeUndefined();
  });

  it("bounds stored summaries before building the full-workspace inference request", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(ollamaResponse({ relationships: [] }));
    const model = new OllamaCollectionRelationshipModel({ fetchImpl });
    const evidenceIds = Array.from({ length: 6 }, (_, index) => `node:evidence_${index + 1}`);

    await model.infer({
      summaries: [
        {
          collectionId: "collection_long",
          name: "Long",
          kind: "documents",
          digest: `Concrete relationship evidence ${"detail ".repeat(140)}TAIL_MARKER`,
          summaryVersion: "long-v1",
          evidenceIds,
        },
      ],
    });

    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(request.messages[1].content).not.toContain("TAIL_MARKER");
    expect(request.messages[1].content).toContain(evidenceIds[3]);
    expect(request.messages[1].content).not.toContain(evidenceIds[4]);
  });

  it("rejects summary evidence the model was not shown", async () => {
    const model = new OllamaCollectionRelationshipModel({
      fetchImpl: vi.fn(async () =>
        ollamaResponse({
          digest:
            "The collection documents a concrete checkout workflow through the payment service before confirming an order.",
          evidenceIds: ["node:not-supplied"],
        }),
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

  it("replaces identifier-only output with an extractive summary", async () => {
    const model = new OllamaCollectionRelationshipModel({
      fetchImpl: vi.fn(async () =>
        ollamaResponse({ digest: "doco_01M46A3A7QZ1FSSN1DDY18K5CM", evidenceIds: ["node:real"] }),
      ),
    });

    await expect(
      model.summarize({
        collectionId: "collection_one",
        name: "One",
        kind: "generic",
        goal: "",
        sources: [
          {
            evidenceId: "node:real",
            title: "Checkout decision",
            content: "Checkout uses the payment service before order confirmation.",
          },
        ],
      }),
    ).resolves.toEqual({
      digest: expect.stringContaining(
        "Checkout uses the payment service before order confirmation.",
      ),
      evidenceIds: ["node:real"],
    });
  });

  it("replaces identifier lists padded past the summary minimum", async () => {
    const model = new OllamaCollectionRelationshipModel({
      fetchImpl: vi.fn(async () =>
        ollamaResponse({
          digest:
            "doco_01M3T6V5JN0RZAEH05RND2ZT90#torre-codebase#code:torre-labs/api-gateway:CHANGELOG.md#code:torre-labs/api-gateway:docs/public-api/index.md",
          evidenceIds: ["node:real"],
        }),
      ),
    });

    await expect(
      model.summarize({
        collectionId: "collection_code",
        name: "Codebase",
        kind: "codebase",
        goal: "",
        sources: [
          {
            evidenceId: "node:real",
            title: "API gateway",
            content: "The API gateway publishes its public API and records changes.",
          },
        ],
      }),
    ).resolves.toEqual({
      digest: expect.stringContaining(
        "The API gateway publishes its public API and records changes.",
      ),
      evidenceIds: ["node:real"],
    });
  });

  it("replaces malformed model JSON with an extractive summary", async () => {
    const model = new OllamaCollectionRelationshipModel({
      fetchImpl: vi.fn(async () =>
        Response.json({ message: { content: '{"digest":"unfinished' } }),
      ),
    });

    await expect(
      model.summarize({
        collectionId: "collection_notion",
        name: "Notion",
        kind: "notion",
        goal: "",
        sources: [
          {
            evidenceId: "notion:page-one",
            title: "Checkout architecture",
            content: "The handbook documents checkout through the payment service.",
          },
        ],
      }),
    ).resolves.toEqual({
      digest: expect.stringContaining(
        "The handbook documents checkout through the payment service.",
      ),
      evidenceIds: ["notion:page-one"],
    });
  });
});
