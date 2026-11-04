import { describe, expect, it, vi } from "vitest";

import {
  buildCollectionRelationsBenchmarkRequest,
  decodeCollectionRelationsBenchmarkResponse,
  fetchCollectionRelationsBenchmark,
  parseCollectionRelationsArgs,
  scoreCollectionRelationships,
  validateBenchmarkRelationships,
  validateCollectionRelationsFixture,
  visibleBenchmarkFixture,
} from "../../scripts/collection-relations-bench-lib.mjs";

const fixture = {
  collections: [
    {
      collectionId: "atlas-product",
      name: "Atlas product decisions",
      digest: "Defines the Atlas customer workflows and requirements.",
      summaryVersion: "product-v1",
      evidenceIds: ["decision_atlas"],
    },
    {
      collectionId: "atlas-code",
      name: "Atlas application",
      digest: "Implements the workflows specified by Atlas product decisions.",
      summaryVersion: "code-v1",
      evidenceIds: ["reference_atlas_code"],
    },
    {
      collectionId: "beacon-product",
      name: "Beacon product decisions",
      digest: "Defines Beacon's incident-management experience.",
      summaryVersion: "beacon-v1",
      evidenceIds: ["decision_beacon"],
    },
  ],
  relationships: [{ from: "atlas-code", to: "atlas-product", type: "implements" }],
};

describe("collection relationship benchmark", () => {
  it("parses explicit model, repeat, and nested batch settings", () => {
    expect(
      parseCollectionRelationsArgs(
        [
          "--fixture",
          "/tmp/relations.json",
          "--model",
          "google/gemini-3.5-flash-lite",
          "--batch-sizes",
          "8,16,32",
          "--repeats",
          "3",
          "--anchor",
          "atlas-code",
        ],
        { OPENROUTER_API_KEY: "router-secret" },
      ),
    ).toMatchObject({
      fixture: "/tmp/relations.json",
      model: "google/gemini-3.5-flash-lite",
      batchSizes: [8, 16, 32],
      repeats: 3,
      anchor: "atlas-code",
    });
  });

  it("configures Gemini Flash-Lite through OpenRouter without changing the benchmark contract", () => {
    expect(
      parseCollectionRelationsArgs([], {
        OPENROUTER_API_KEY: "router-secret",
      }),
    ).toMatchObject({
      provider: "openrouter",
      model: "google/gemini-3.5-flash-lite",
      url: "https://openrouter.ai/api/v1/chat/completions",
      apiToken: "router-secret",
    });
  });

  it("builds and decodes a deterministic OpenRouter structured-output request", () => {
    const schema = {
      type: "object",
      properties: { relationships: { type: "array", items: { type: "object" } } },
      required: ["relationships"],
    };
    expect(
      buildCollectionRelationsBenchmarkRequest(
        {
          model: "google/gemini-3.5-flash-lite",
          apiToken: "router-secret",
        },
        { systemPrompt: "system", prompt: "prompt", schema },
      ),
    ).toEqual({
      headers: {
        authorization: "Bearer router-secret",
        "content-type": "application/json",
      },
      body: {
        model: "google/gemini-3.5-flash-lite",
        stream: false,
        temperature: 0,
        max_tokens: 4096,
        reasoning: { effort: "minimal" },
        provider: { require_parameters: true, data_collection: "deny" },
        response_format: {
          type: "json_schema",
          json_schema: { name: "collection_relationships", strict: true, schema },
        },
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "prompt" },
        ],
      },
    });

    expect(
      decodeCollectionRelationsBenchmarkResponse({
        choices: [{ message: { content: JSON.stringify({ relationships: [] }) } }],
        usage: { prompt_tokens: 123, completion_tokens: 45 },
      }),
    ).toEqual({
      relationships: [],
      promptTokens: 123,
      outputTokens: 45,
      providerDurationMs: 0,
    });
  });

  it("retries transient model capacity failures without retrying bad requests", async () => {
    const responses = [
      { ok: false, status: 503 },
      { ok: true, status: 200 },
    ];
    const fetchModel = vi.fn(async () => responses.shift());
    const sleep = vi.fn(async () => undefined);

    await expect(
      fetchCollectionRelationsBenchmark("https://model.test", {}, { fetchModel, sleep }),
    ).resolves.toMatchObject({ status: 200 });
    expect(fetchModel).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);

    fetchModel.mockResolvedValueOnce({ ok: false, status: 400 });
    await expect(
      fetchCollectionRelationsBenchmark("https://model.test", {}, { fetchModel, sleep }),
    ).resolves.toMatchObject({ status: 400 });
    expect(fetchModel).toHaveBeenCalledTimes(3);
  });

  it("rejects non-increasing or duplicate batch sizes", () => {
    expect(() => parseCollectionRelationsArgs(["--batch-sizes", "16,8"], {})).toThrow(
      /strictly increasing/i,
    );
    expect(() => parseCollectionRelationsArgs(["--batch-sizes", "8,8"], {})).toThrow(
      /strictly increasing/i,
    );
  });

  it("keeps only collections and gold relationships visible in a nested batch", () => {
    expect(visibleBenchmarkFixture(fixture, 2)).toEqual({
      collections: fixture.collections.slice(0, 2),
      relationships: fixture.relationships,
    });
    expect(visibleBenchmarkFixture(fixture, 1)).toEqual({
      collections: fixture.collections.slice(0, 1),
      relationships: [],
    });
    expect(visibleBenchmarkFixture(fixture, 3, "atlas-code")).toEqual({
      collections: fixture.collections,
      relationships: fixture.relationships,
    });
    expect(visibleBenchmarkFixture(fixture, 3, "beacon-product")).toEqual({
      collections: fixture.collections,
      relationships: [],
    });
  });

  it("rejects duplicate collection ids and gold edges with unknown endpoints", () => {
    expect(() =>
      validateCollectionRelationsFixture({
        ...fixture,
        collections: [...fixture.collections, fixture.collections[0]],
      }),
    ).toThrow(/duplicate collection id/i);
    expect(() =>
      validateCollectionRelationsFixture({
        ...fixture,
        relationships: [{ from: "missing", to: "atlas-product", type: "implements" }],
      }),
    ).toThrow(/unknown collection/i);
  });

  it("scores exact edge quality, endpoint discovery, direction, type, and evidence support", () => {
    const predictions = [
      {
        from: "atlas-code",
        to: "atlas-product",
        type: "implements",
        confidence: 0.94,
        evidence: [
          {
            collectionId: "atlas-code",
            summaryVersion: "code-v1",
            evidenceIds: ["reference_atlas_code"],
          },
          {
            collectionId: "atlas-product",
            summaryVersion: "product-v1",
            evidenceIds: ["decision_atlas"],
          },
        ],
      },
      {
        from: "beacon-product",
        to: "atlas-product",
        type: "documents",
        confidence: 0.61,
        evidence: [],
      },
    ];

    expect(scoreCollectionRelationships(fixture, predictions)).toEqual({
      gold: 1,
      predicted: 2,
      exactTruePositives: 1,
      precision: 0.5,
      recall: 1,
      recallCeiling: 1,
      budgetRecall: 1,
      f1: 2 / 3,
      endpointPairRecall: 1,
      typeAccuracy: 1,
      directionAccuracy: 1,
      unsupportedEdges: 1,
      unsupportedRate: 0.5,
      invalidEdges: 0,
    });
  });

  it("separates model misses from the eight-edge response budget", () => {
    const collections = Array.from({ length: 10 }, (_, index) => ({
      collectionId: `collection-${index}`,
      name: `Collection ${index}`,
      digest: `Concrete collection ${index} evidence for the relationship benchmark fixture.`,
      summaryVersion: "v1",
      evidenceIds: [`evidence-${index}`],
    }));
    const relationships = Array.from({ length: 9 }, (_, index) => ({
      from: `collection-${index}`,
      to: `collection-${index + 1}`,
      type: "depends_on",
    }));
    const predictions = relationships.slice(0, 8).map((relationship) => ({
      ...relationship,
      confidence: 0.9,
      evidence: [relationship.from, relationship.to].map((collectionId) => ({
        collectionId,
        summaryVersion: "v1",
        evidenceIds: [`evidence-${collectionId.split("-").at(-1)}`],
      })),
    }));

    expect(scoreCollectionRelationships({ collections, relationships }, predictions)).toMatchObject(
      {
        recall: 8 / 9,
        recallCeiling: 8 / 9,
        budgetRecall: 1,
      },
    );
  });

  it("counts reversed and mistyped known pairs without granting exact credit", () => {
    const predictions = [
      {
        from: "atlas-product",
        to: "atlas-code",
        type: "documents",
        confidence: 0.8,
        evidence: [
          {
            collectionId: "atlas-code",
            summaryVersion: "code-v1",
            evidenceIds: ["reference_atlas_code"],
          },
          {
            collectionId: "atlas-product",
            summaryVersion: "product-v1",
            evidenceIds: ["decision_atlas"],
          },
        ],
      },
    ];

    expect(scoreCollectionRelationships(fixture, predictions)).toMatchObject({
      exactTruePositives: 0,
      endpointPairRecall: 1,
      typeAccuracy: 0,
      directionAccuracy: 0,
    });
  });

  it("penalizes duplicate predictions without allowing recall above one", () => {
    const prediction = {
      from: "atlas-code",
      to: "atlas-product",
      type: "implements",
      confidence: 0.9,
      evidence: [
        {
          collectionId: "atlas-code",
          summaryVersion: "code-v1",
          evidenceIds: ["reference_atlas_code"],
        },
        {
          collectionId: "atlas-product",
          summaryVersion: "product-v1",
          evidenceIds: ["decision_atlas"],
        },
      ],
    };

    expect(scoreCollectionRelationships(fixture, [prediction, prediction])).toMatchObject({
      gold: 1,
      predicted: 2,
      exactTruePositives: 1,
      precision: 0.5,
      recall: 1,
    });
  });

  it("applies production validation to unanchored workspace runs", () => {
    const prediction = {
      from: "atlas-code",
      to: "atlas-product",
      type: "implements",
      confidence: 0.9,
      evidence: [
        {
          collectionId: "atlas-code",
          summaryVersion: "code-v1",
          evidenceIds: ["reference_atlas_code"],
        },
        {
          collectionId: "atlas-product",
          summaryVersion: "product-v1",
          evidenceIds: ["decision_atlas"],
        },
      ],
    };

    expect(validateBenchmarkRelationships(fixture.collections, [prediction, prediction])).toEqual({
      accepted: [prediction],
      rejected: [expect.objectContaining({ reasons: ["duplicate_relationship"] })],
    });
  });

  it("counts malformed model output as invalid instead of crashing the scorer", () => {
    expect(scoreCollectionRelationships(fixture, [null])).toMatchObject({
      predicted: 1,
      exactTruePositives: 0,
      recall: 0,
      invalidEdges: 1,
      unsupportedEdges: 1,
    });
  });
});
