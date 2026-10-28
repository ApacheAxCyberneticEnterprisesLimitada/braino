import { describe, expect, it } from "vitest";
import { LocalNlpRetrievalExtractor } from "../local-nlp-retrieval-extractor.js";
import { validateRetrievalExtraction } from "../retrieval-ontology.js";

const DOCUMENT = {
  collectionId: "collection_test",
  source: "code",
  externalId: "torre/solar:README.md",
  title: "Solar",
  content: "Solar uses JDK 8.",
};

async function validated(content: string) {
  const document = { ...DOCUMENT, content };
  const chunks = [{ text: content, breadcrumb: DOCUMENT.title }];
  const extraction = await new LocalNlpRetrievalExtractor().extract({ document, chunks });
  return validateRetrievalExtraction(document, chunks, extraction).extraction;
}

describe("LocalNlpRetrievalExtractor", () => {
  it("extracts an explicit relationship from the existing retrieval chunk", async () => {
    const extraction = await validated("Solar uses JDK 8.");

    expect(extraction.entities.map(({ name, type }) => ({ name, type }))).toEqual([
      { name: "Solar", type: "service" },
      { name: "JDK 8", type: "technology" },
    ]);
    expect(extraction.relationships).toMatchObject([
      { type: "USES", fact: "Solar uses JDK 8.", chunkIndex: 0 },
    ]);
  });

  it("resolves an explicit codename as an alias instead of inventing an edge", async () => {
    const extraction = await validated(
      "The language-tests initiative is codenamed chore-missandei. " +
        "The rollout of chore-missandei is paused.",
    );

    expect(extraction.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "language-tests",
          type: "effort",
          aliases: ["chore-missandei"],
        }),
        expect.objectContaining({ name: "paused", type: "status" }),
      ]),
    );
    expect(extraction.relationships).toMatchObject([
      { type: "HAS_STATUS", fact: "The rollout of chore-missandei is paused." },
    ]);
  });

  it("does not turn uncertain or negated text into graph edges", async () => {
    const extraction = await validated(
      "If Solar adopts Java 21, it may run on it later. Solar does not use Java 21.",
    );

    expect(extraction.relationships).toEqual([]);
  });

  it("keeps version numbers intact and expands explicit channel lists", async () => {
    const extraction = await validated(
      "Solar uses Amazon Corretto 8.0.472-amzn. Emma supports email and in-app chat.",
    );
    const byKey = new Map(extraction.entities.map((entity) => [entity.key, entity.name]));

    expect(
      extraction.relationships.map((relation) => [
        byKey.get(relation.fromKey),
        relation.type,
        byKey.get(relation.toKey),
      ]),
    ).toEqual([
      ["Solar", "USES", "Amazon Corretto 8.0.472-amzn"],
      ["Emma", "PROVIDES", "email"],
      ["Emma", "PROVIDES", "in-app chat"],
    ]);
  });

  it("handles an alias parenthetical and dates containing May", async () => {
    const extraction = await validated(
      "Project Phoenix, also called Rebirth, is led by Maya. " +
        "Before 15 May 2026, Jedi ran on EC2.",
    );
    const byKey = new Map(extraction.entities.map((entity) => [entity.key, entity.name]));

    expect(
      extraction.relationships.map((relation) => [
        byKey.get(relation.fromKey),
        relation.type,
        byKey.get(relation.toKey),
      ]),
    ).toEqual([
      ["Maya", "OWNS", "Project Phoenix"],
      ["Jedi", "USES", "EC2"],
    ]);
  });

  it("extracts separate explicit clauses but refuses unresolved pronouns", async () => {
    const extraction = await validated(
      "Atlas owns scoring, while Sensor owns question delivery. " +
        "Jedi is deployed in eu-west-1. It runs on ECS Fargate.",
    );
    const byKey = new Map(extraction.entities.map((entity) => [entity.key, entity.name]));

    expect(
      extraction.relationships.map((relation) => [
        byKey.get(relation.fromKey),
        relation.type,
        byKey.get(relation.toKey),
      ]),
    ).toEqual([
      ["Atlas", "OWNS", "scoring"],
      ["Sensor", "OWNS", "question delivery"],
      ["Jedi", "LOCATED_IN", "eu-west-1"],
    ]);
  });
});
