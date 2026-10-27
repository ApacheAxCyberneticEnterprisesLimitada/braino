import { describe, expect, it } from "vitest";
import {
  formatRetrievalOntologyForPrompt,
  validateRetrievalExtraction,
} from "../retrieval-ontology.js";

const document = {
  collectionId: "collection_eval",
  source: "code",
  externalId: "solar/.github/workflows/build.yml",
  content: "Solar CI installs Temurin JDK 8 before running the build.",
};

describe("retrieval ontology", () => {
  it("accepts grounded entities and a relationship allowed by the ontology", () => {
    const result = validateRetrievalExtraction(document, [{ text: document.content }], {
      entities: [
        {
          key: "solar",
          name: "Solar",
          type: "service",
          mentions: [{ chunkIndex: 0 }],
        },
        {
          key: "jdk-8",
          name: "JDK 8",
          type: "technology",
          aliases: ["Temurin JDK 8"],
          mentions: [{ chunkIndex: 0 }],
        },
      ],
      relationships: [
        {
          fromKey: "solar",
          toKey: "jdk-8",
          type: "USES",
          fact: document.content,
          chunkIndex: 0,
        },
      ],
    });

    expect(result.extraction.entities).toHaveLength(2);
    expect(result.extraction.relationships).toHaveLength(1);
    expect(result.issues).toEqual([]);
  });

  it("rejects unknown entity and relationship types", () => {
    const result = validateRetrievalExtraction(
      {
        ...document,
        content: "Solar is maintained by the platform group.",
      },
      [{ text: "Solar is maintained by the platform group." }],
      {
        entities: [
          {
            key: "solar",
            name: "Solar",
            type: "microservice",
            mentions: [{ chunkIndex: 0 }],
          },
          {
            key: "platform",
            name: "platform group",
            type: "team",
            mentions: [{ chunkIndex: 0 }],
          },
        ],
        relationships: [
          {
            fromKey: "platform",
            toKey: "solar",
            type: "MAINTAINS",
            fact: "Solar is maintained by the platform group.",
            chunkIndex: 0,
          },
        ],
      },
    );

    expect(result.extraction.entities.map((entity) => entity.key)).toEqual(["platform"]);
    expect(result.extraction.relationships).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "unknown_entity_type",
      "unknown_relationship_type",
    ]);
  });

  it("rejects punctuation-only entity names before persistence", () => {
    const text = "The migration status is - pending.";
    const result = validateRetrievalExtraction({ ...document, content: text }, [{ text }], {
      entities: [
        {
          key: "punctuation",
          name: "-",
          type: "status",
          mentions: [{ chunkIndex: 0, startOffset: 24, endOffset: 25 }],
        },
      ],
      relationships: [],
    });

    expect(result.extraction.entities).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).toEqual(["invalid_entity_name"]);
  });

  it("rejects invented evidence and relationships whose entities were not grounded", () => {
    const result = validateRetrievalExtraction(document, [{ text: document.content }], {
      entities: [
        {
          key: "solar",
          name: "Solar",
          type: "service",
          mentions: [{ chunkIndex: 0 }],
        },
        {
          key: "jdk-17",
          name: "JDK 17",
          type: "technology",
          mentions: [{ chunkIndex: 0 }],
        },
      ],
      relationships: [
        {
          fromKey: "solar",
          toKey: "jdk-17",
          type: "USES",
          fact: "Solar uses JDK 17 in production.",
          chunkIndex: 0,
        },
      ],
    });

    expect(result.extraction.entities.map((entity) => entity.key)).toEqual(["solar"]);
    expect(result.extraction.relationships).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "ungrounded_entity",
      "unknown_relationship_endpoint",
    ]);
  });

  it("rejects claims explicitly described as undecided or hypothetical", () => {
    const text = "No decision has been made about whether Vega will support the legacy protocol.";
    const result = validateRetrievalExtraction({ ...document, content: text }, [{ text }], {
      entities: [
        {
          key: "vega",
          name: "Vega",
          type: "service",
          mentions: [{ chunkIndex: 0 }],
        },
        {
          key: "legacy-protocol",
          name: "legacy protocol",
          type: "technology",
          mentions: [{ chunkIndex: 0 }],
        },
      ],
      relationships: [
        {
          fromKey: "vega",
          toKey: "legacy-protocol",
          type: "PROVIDES",
          fact: text,
          chunkIndex: 0,
        },
      ],
    });

    expect(result.extraction.entities).toHaveLength(2);
    expect(result.extraction.relationships).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).toEqual(["uncertain_relationship"]);
  });

  it("keeps an explicit status when pending text describes its condition", () => {
    const text = "The rollout of chore-missandei is paused pending calibration.";
    const result = validateRetrievalExtraction({ ...document, content: text }, [{ text }], {
      entities: [
        {
          key: "missandei",
          name: "chore-missandei",
          type: "effort",
          mentions: [{ chunkIndex: 0 }],
        },
        {
          key: "paused",
          name: "paused",
          type: "status",
          mentions: [{ chunkIndex: 0 }],
        },
      ],
      relationships: [
        {
          fromKey: "missandei",
          toKey: "paused",
          type: "HAS_STATUS",
          fact: text,
          chunkIndex: 0,
        },
      ],
    });

    expect(result.extraction.relationships).toHaveLength(1);
    expect(result.issues).toEqual([]);
  });

  it("rejects a relationship predicate that contradicts the evidence", () => {
    const text = "Atlas and Hermes share ownership of the pre-screening backend.";
    const result = validateRetrievalExtraction({ ...document, content: text }, [{ text }], {
      entities: [
        {
          key: "atlas",
          name: "Atlas",
          type: "service",
          mentions: [{ chunkIndex: 0 }],
        },
        {
          key: "backend",
          name: "pre-screening backend",
          type: "capability",
          mentions: [{ chunkIndex: 0 }],
        },
      ],
      relationships: [
        {
          fromKey: "atlas",
          toKey: "backend",
          type: "RESPONSIBLE_FOR",
          fact: text,
          chunkIndex: 0,
        },
      ],
    });

    expect(result.extraction.relationships).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).toEqual(["unsupported_predicate"]);
  });

  it("rejects cross-sentence edges that merely place unrelated entities near a predicate", () => {
    const text = "Chore-missandei entered pilot rollout. Solar uses JDK 8.";
    const result = validateRetrievalExtraction({ ...document, content: text }, [{ text }], {
      entities: [
        {
          key: "missandei",
          name: "Chore-missandei",
          type: "effort",
          mentions: [{ chunkIndex: 0 }],
        },
        {
          key: "solar",
          name: "Solar",
          type: "service",
          mentions: [{ chunkIndex: 0 }],
        },
      ],
      relationships: [
        {
          fromKey: "missandei",
          toKey: "solar",
          type: "USES",
          fact: text,
          chunkIndex: 0,
        },
      ],
    });

    expect(result.extraction.relationships).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).toEqual(["ambiguous_relationship_evidence"]);
  });

  it("requires relationship evidence to name both endpoints", () => {
    const text = "Solar uses JDK 8. Radar is also active.";
    const result = validateRetrievalExtraction({ ...document, content: text }, [{ text }], {
      entities: [
        {
          key: "radar",
          name: "Radar",
          type: "service",
          mentions: [{ chunkIndex: 0 }],
        },
        {
          key: "jdk-8",
          name: "JDK 8",
          type: "technology",
          mentions: [{ chunkIndex: 0 }],
        },
      ],
      relationships: [
        {
          fromKey: "radar",
          toKey: "jdk-8",
          type: "USES",
          fact: "Solar uses JDK 8.",
          chunkIndex: 0,
        },
      ],
    });

    expect(result.extraction.relationships).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).toEqual(["ambiguous_relationship_evidence"]);
  });

  it("accepts passive ownership only in its canonical owner-to-subject direction", () => {
    const text = "Project Phoenix is led by Maya.";
    const valid = validateRetrievalExtraction({ ...document, content: text }, [{ text }], {
      entities: [
        {
          key: "phoenix",
          name: "Project Phoenix",
          type: "project",
          mentions: [{ chunkIndex: 0 }],
        },
        {
          key: "maya",
          name: "Maya",
          type: "person",
          mentions: [{ chunkIndex: 0 }],
        },
      ],
      relationships: [
        {
          fromKey: "maya",
          toKey: "phoenix",
          type: "OWNS",
          fact: text,
          chunkIndex: 0,
        },
      ],
    });
    const reversed = validateRetrievalExtraction({ ...document, content: text }, [{ text }], {
      entities: valid.extraction.entities,
      relationships: [
        {
          fromKey: "phoenix",
          toKey: "maya",
          type: "OWNS",
          fact: text,
          chunkIndex: 0,
        },
      ],
    });

    expect(valid.extraction.relationships).toHaveLength(1);
    expect(reversed.extraction.relationships).toEqual([]);
    expect(reversed.issues.map((issue) => issue.code)).toEqual(["invalid_relationship_types"]);
  });

  it("uses the same general relationship for people and software", () => {
    const text = "Maya uses Salesforce. Solar uses JDK 8.";
    const result = validateRetrievalExtraction({ ...document, content: text }, [{ text }], {
      entities: [
        {
          key: "maya",
          name: "Maya",
          type: "person",
          mentions: [{ chunkIndex: 0 }],
        },
        {
          key: "salesforce",
          name: "Salesforce",
          type: "technology",
          mentions: [{ chunkIndex: 0 }],
        },
        {
          key: "solar",
          name: "Solar",
          type: "service",
          mentions: [{ chunkIndex: 0 }],
        },
        {
          key: "jdk-8",
          name: "JDK 8",
          type: "technology",
          mentions: [{ chunkIndex: 0 }],
        },
      ],
      relationships: [
        {
          fromKey: "maya",
          toKey: "salesforce",
          type: "USES",
          fact: "Maya uses Salesforce.",
          chunkIndex: 0,
        },
        {
          fromKey: "solar",
          toKey: "jdk-8",
          type: "USES",
          fact: "Solar uses JDK 8.",
          chunkIndex: 0,
        },
      ],
    });

    expect(result.extraction.relationships).toHaveLength(2);
    expect(result.issues).toEqual([]);
  });

  it("renders the exact ontology used by validation for the extractor prompt", () => {
    const prompt = formatRetrievalOntologyForPrompt();

    expect(prompt).toContain("service");
    expect(prompt).toContain(
      "USES: person|team|service|product|effort|project -> technology|service|product|communication_channel",
    );
    expect(prompt).toContain("RESPONSIBLE_FOR: person|team|service ->");
    expect(prompt).toContain("Only use the entity and relationship types listed above");
  });
});
