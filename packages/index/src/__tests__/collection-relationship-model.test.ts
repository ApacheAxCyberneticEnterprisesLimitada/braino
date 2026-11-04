import { describe, expect, it, vi } from "vitest";

import {
  COLLECTION_RELATIONSHIP_PIPELINE_VERSION,
  COLLECTION_SUMMARY_PIPELINE_VERSION,
  DEFAULT_COLLECTION_RELATIONSHIP_MODEL,
  DEFAULT_COLLECTION_RELATIONSHIP_TIMEOUT_MS,
  DEFAULT_COLLECTION_RELATIONSHIP_URL,
  OpenRouterCollectionRelationshipModel,
  configuredCollectionRelationshipModel,
} from "../collection-relationship-model.js";

function openRouterResponse(content: unknown): Response {
  return Response.json({
    choices: [{ message: { content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 12, completion_tokens: 7 },
  });
}

describe("OpenRouter collection relationship model", () => {
  it("finishes a model request before the serverless function deadline", () => {
    expect(DEFAULT_COLLECTION_RELATIONSHIP_TIMEOUT_MS).toBe(180_000);
    expect(DEFAULT_COLLECTION_RELATIONSHIP_MODEL).toBe("google/gemini-3.5-flash-lite");
    expect(DEFAULT_COLLECTION_RELATIONSHIP_URL).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
  });

  it("invalidates Qwen summaries and graph inference after the Gemini migration", () => {
    expect(COLLECTION_SUMMARY_PIPELINE_VERSION).toBe("workspace-graph-v5-gemini-summaries");
    expect(COLLECTION_RELATIONSHIP_PIPELINE_VERSION).toBe(
      "workspace-graph-v9-gemini-generate-audit",
    );
  });

  it("is disabled unless OpenRouter is configured", () => {
    expect(configuredCollectionRelationshipModel({})).toBeNull();
    expect(configuredCollectionRelationshipModel({ OPENROUTER_API_KEY: "router-secret" })?.id).toBe(
      "openrouter:google/gemini-3.5-flash-lite",
    );
  });

  it("summarizes evidence and infers relationships through strict Gemini requests", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        openRouterResponse({
          digest:
            "The collection defines checkout through the payment service and confirms orders only after payment succeeds.",
          evidenceIds: ["node:decision_checkout"],
        }),
      )
      .mockResolvedValueOnce(
        openRouterResponse({
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
    const model = new OpenRouterCollectionRelationshipModel({
      model: "google/gemini-3.5-flash-lite",
      url: "https://openrouter.test/api/v1/chat/completions",
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

    expect(model.id).toBe("openrouter:google/gemini-3.5-flash-lite");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const request = fetchImpl.mock.calls[0]?.[1];
    expect(request?.headers).toEqual({
      authorization: "Bearer secret",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(request?.body))).toMatchObject({
      model: "google/gemini-3.5-flash-lite",
      stream: false,
      temperature: 0,
      max_tokens: 640,
      reasoning: { effort: "minimal" },
      provider: { require_parameters: true, data_collection: "deny" },
      response_format: {
        type: "json_schema",
        json_schema: { name: "collection_summary", strict: true },
      },
    });
    const summaryRequest = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(
      summaryRequest.response_format.json_schema.schema.properties.evidenceIds.items.enum,
    ).toEqual(["node:decision_checkout"]);
    expect(summaryRequest.response_format.json_schema.schema.properties.digest).toMatchObject({
      minLength: 80,
    });
    expect(summaryRequest.messages[1].content).toContain('"kind":"product-decisions"');
    expect(summaryRequest.messages[1].content).toContain("Preserve concrete overlap");
    expect(summaryRequest.messages[1].content).toContain("Never return only a collection name");
    const relationshipRequest = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(relationshipRequest.max_tokens).toBe(768);
    expect(relationshipRequest.messages[0].content).toContain("every unordered pair");
    expect(relationshipRequest.messages[1].content).toContain("Evaluate every unordered pair");
    expect(relationshipRequest.messages[1].content).toContain(
      "A codebase can implement architectural decisions",
    );
    expect(relationshipRequest.messages[1].content).toContain(
      "Return at most 8 strongest relationships",
    );
    expect(relationshipRequest.messages[1].content).toContain(
      "Return only from, to, type, and confidence",
    );
    expect(
      relationshipRequest.response_format.json_schema.schema.properties.relationships.maxItems,
    ).toBe(8);
    expect(relationshipRequest.messages[1].content).toContain("existing-code baseline");
    expect(relationshipRequest.messages[1].content).toContain(
      "translation → codebase is derived_from",
    );
    expect(
      relationshipRequest.response_format.json_schema.schema.properties.relationships.items
        .properties.from.enum,
    ).toEqual(["collection_code", "collection_product"]);
    expect(
      relationshipRequest.response_format.json_schema.schema.properties.relationships.items
        .required,
    ).toEqual(["from", "to", "type", "confidence"]);
    expect(
      relationshipRequest.response_format.json_schema.schema.properties.relationships.items
        .properties.evidence,
    ).toBeUndefined();
  });

  it("bounds stored summaries before building the full-workspace inference request", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(openRouterResponse({ relationships: [] }));
    const model = new OpenRouterCollectionRelationshipModel({ fetchImpl });
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

  it("runs a focused Gemini pass when the workspace pass misses code-derived translations", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(openRouterResponse({ relationships: [] }))
      .mockResolvedValueOnce(
        openRouterResponse({
          relationships: [
            {
              from: "collection_code",
              to: "collection_translations",
              type: "depends_on",
              confidence: 0.99,
            },
            {
              from: "collection_translations",
              to: "collection_code",
              type: "derived_from",
              confidence: 0.96,
            },
            {
              from: "collection_translations",
              to: "collection_code",
              type: "documents",
              confidence: 0.98,
            },
          ],
        }),
      );
    const model = new OpenRouterCollectionRelationshipModel({ fetchImpl });

    await expect(
      model.infer({
        summaries: [
          {
            collectionId: "collection_code",
            name: "Torre codebase",
            kind: "codebase",
            digest: "The Scala application contains the runtime message orchestration.",
            summaryVersion: "code-v1",
            evidenceIds: ["github:runtime"],
          },
          {
            collectionId: "collection_translations",
            name: "Torre translations",
            kind: "generic",
            digest: `English and Spanish translation records preserve exact localized copy. ${"Additional translation copy. ".repeat(35)} Status: existing-code baseline from fetched default branches; current runtime use is not verified.`,
            summaryVersion: "translations-v1",
            evidenceIds: ["reference:translation"],
          },
          {
            collectionId: "collection_product",
            name: "Product decisions",
            kind: "product-decisions",
            digest: "Product requirements for the job hub experience.",
            summaryVersion: "product-v1",
            evidenceIds: ["decision:job-hub"],
          },
        ],
      }),
    ).resolves.toEqual([
      {
        from: "collection_translations",
        to: "collection_code",
        type: "derived_from",
        confidence: 0.96,
        evidence: [
          {
            collectionId: "collection_translations",
            summaryVersion: "translations-v1",
            evidenceIds: ["reference:translation"],
          },
          {
            collectionId: "collection_code",
            summaryVersion: "code-v1",
            evidenceIds: ["github:runtime"],
          },
        ],
      },
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const focusedRequest = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(focusedRequest.messages[1].content).toContain(
      "Evaluate only these required coverage pairs",
    );
    expect(focusedRequest.messages[1].content).toContain(
      "collection_translations ↔ collection_code",
    );
    expect(focusedRequest.messages[1].content).toContain("existing-code baseline");
    expect(focusedRequest.messages[1].content).not.toContain("collection_product");
    expect(
      focusedRequest.response_format.json_schema.schema.properties.relationships.items.properties
        .from.enum,
    ).toEqual(["collection_code", "collection_translations"]);
  });

  it("rejects summary evidence the model was not shown", async () => {
    const model = new OpenRouterCollectionRelationshipModel({
      fetchImpl: vi.fn(async () =>
        openRouterResponse({
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
    const model = new OpenRouterCollectionRelationshipModel({
      fetchImpl: vi.fn(async () =>
        openRouterResponse({
          digest: "doco_01M46A3A7QZ1FSSN1DDY18K5CM",
          evidenceIds: ["node:real"],
        }),
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
    const model = new OpenRouterCollectionRelationshipModel({
      fetchImpl: vi.fn(async () =>
        openRouterResponse({
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
    const model = new OpenRouterCollectionRelationshipModel({
      fetchImpl: vi.fn(async () =>
        Response.json({ choices: [{ message: { content: '{"digest":"unfinished' } }] }),
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
