import { describe, expect, it } from "vitest";

import {
  parseCollectionRelationsArgs,
  scoreCollectionRelationships,
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
  it("parses explicit model, context, repeat, and nested batch settings", () => {
    expect(
      parseCollectionRelationsArgs(
        [
          "--fixture",
          "/tmp/relations.json",
          "--model",
          "qwen3:8b",
          "--batch-sizes",
          "8,16,32",
          "--num-ctx",
          "16384",
          "--repeats",
          "3",
          "--anchor",
          "atlas-code",
        ],
        {},
      ),
    ).toMatchObject({
      fixture: "/tmp/relations.json",
      model: "qwen3:8b",
      batchSizes: [8, 16, 32],
      numCtx: 16_384,
      repeats: 3,
      anchor: "atlas-code",
    });
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
      f1: 2 / 3,
      endpointPairRecall: 1,
      typeAccuracy: 1,
      directionAccuracy: 1,
      unsupportedEdges: 1,
      unsupportedRate: 0.5,
      invalidEdges: 0,
    });
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
