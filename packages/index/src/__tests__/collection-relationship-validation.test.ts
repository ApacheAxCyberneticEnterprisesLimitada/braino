import { describe, expect, it } from "vitest";

import {
  type CollectionRelationshipInference,
  type CollectionRelationshipValidationScope,
  buildCollectionRelationsPrompt,
  collectionRelationshipsResponseSchema,
  validateCollectionRelationships,
} from "../collection-relationship-validation.js";

const scope: CollectionRelationshipValidationScope = {
  anchorId: "atlas-code",
  summaries: [
    {
      collectionId: "atlas-code",
      summaryVersion: "code-v2",
      evidenceIds: ["code-checkout", "code-ledger"],
    },
    {
      collectionId: "atlas-product",
      summaryVersion: "product-v4",
      evidenceIds: ["product-checkout"],
    },
    {
      collectionId: "atlas-ledger",
      summaryVersion: "ledger-v1",
      evidenceIds: ["ledger-consumers"],
    },
    {
      collectionId: "atlas-docs",
      summaryVersion: "docs-v3",
      evidenceIds: ["docs-checkout"],
    },
  ],
};

function relationship(
  overrides: Partial<CollectionRelationshipInference> = {},
): CollectionRelationshipInference {
  return {
    from: "atlas-code",
    to: "atlas-product",
    type: "implements",
    confidence: 0.93,
    evidence: [
      {
        collectionId: "atlas-product",
        summaryVersion: "product-v4",
        evidenceIds: ["product-checkout"],
      },
      {
        collectionId: "atlas-code",
        summaryVersion: "code-v2",
        evidenceIds: ["code-ledger", "code-checkout", "code-checkout"],
      },
    ],
    ...overrides,
  };
}

describe("collection relationship validation", () => {
  it("accepts grounded anchor edges and canonicalizes their evidence", () => {
    expect(validateCollectionRelationships(scope, [relationship()])).toEqual({
      accepted: [
        {
          from: "atlas-code",
          to: "atlas-product",
          type: "implements",
          confidence: 0.93,
          evidence: [
            {
              collectionId: "atlas-code",
              summaryVersion: "code-v2",
              evidenceIds: ["code-checkout", "code-ledger"],
            },
            {
              collectionId: "atlas-product",
              summaryVersion: "product-v4",
              evidenceIds: ["product-checkout"],
            },
          ],
        },
      ],
      rejected: [],
    });
  });

  it("rejects non-anchor output and duplicate directed edges", () => {
    const nonAnchor = relationship({
      from: "atlas-docs",
      to: "atlas-product",
      type: "documents",
      evidence: [
        {
          collectionId: "atlas-docs",
          summaryVersion: "docs-v3",
          evidenceIds: ["docs-checkout"],
        },
        {
          collectionId: "atlas-product",
          summaryVersion: "product-v4",
          evidenceIds: ["product-checkout"],
        },
      ],
    });

    const result = validateCollectionRelationships(scope, [
      relationship(),
      relationship(),
      nonAnchor,
    ]);

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected.map((rejection) => rejection.reasons)).toEqual([
      ["duplicate_relationship"],
      ["outside_anchor_scope"],
    ]);
  });

  it("rejects stale, foreign, unknown, and missing endpoint evidence", () => {
    const result = validateCollectionRelationships(scope, [
      relationship({
        evidence: [
          {
            collectionId: "atlas-code",
            summaryVersion: "code-v1",
            evidenceIds: ["code-checkout"],
          },
          {
            collectionId: "atlas-product",
            summaryVersion: "product-v4",
            evidenceIds: ["code-checkout"],
          },
          {
            collectionId: "atlas-ledger",
            summaryVersion: "ledger-v1",
            evidenceIds: ["ledger-consumers"],
          },
        ],
      }),
      relationship({
        evidence: [
          {
            collectionId: "atlas-code",
            summaryVersion: "code-v2",
            evidenceIds: ["code-checkout"],
          },
        ],
      }),
    ]);

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]?.reasons).toEqual([
      "foreign_evidence",
      "stale_summary",
      "unknown_evidence",
    ]);
    expect(result.rejected[1]?.reasons).toEqual(["missing_endpoint_evidence"]);
  });

  it("rejects malformed shape, self-links, unsupported types, confidence, and endpoints", () => {
    const result = validateCollectionRelationships(scope, [
      null,
      relationship({ from: "atlas-code", to: "atlas-code" }),
      relationship({ type: "related_to" as "implements" }),
      relationship({ confidence: 2 }),
      relationship({ to: "missing-collection" }),
    ]);

    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((rejection) => rejection.reasons)).toEqual([
      ["malformed_relationship"],
      ["self_relationship"],
      ["unsupported_relationship_type"],
      ["invalid_confidence"],
      ["unknown_endpoint"],
    ]);
  });

  it("rejects invalid validation scopes before inspecting model output", () => {
    expect(() =>
      validateCollectionRelationships({ ...scope, anchorId: "missing-collection" }, []),
    ).toThrow(/anchor/i);
    expect(() =>
      validateCollectionRelationships(
        { ...scope, summaries: [...scope.summaries, scope.summaries[0]] },
        [],
      ),
    ).toThrow(/duplicate/i);
  });

  it("requests current evidence from both anchor endpoints in one canonical shape", () => {
    const prompt = buildCollectionRelationsPrompt(
      [
        {
          collectionId: "atlas-code",
          name: "Atlas application",
          digest: "Implements Atlas checkout.",
          summaryVersion: "code-v2",
          evidenceIds: ["code-checkout"],
        },
        {
          collectionId: "atlas-product",
          name: "Atlas product",
          digest: "Defines Atlas checkout.",
          summaryVersion: "product-v4",
          evidenceIds: ["product-checkout"],
        },
      ],
      { anchorId: "atlas-code" },
    );

    expect(prompt).toContain("Every relationship must involve atlas-code");
    expect(prompt).toContain("summaryVersion");
    expect(prompt).toContain("evidenceIds");
    expect(prompt).toContain("from=implementation, to=product, type=implements");
    expect(
      collectionRelationshipsResponseSchema.properties.relationships.items.properties.evidence.items
        .required,
    ).toEqual(["collectionId", "summaryVersion", "evidenceIds"]);
  });
});
