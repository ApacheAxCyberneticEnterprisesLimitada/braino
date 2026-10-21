import { type EmbeddingProviderLike, type QueryClient, ingestRetrievalDocument } from "@doco/db";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import { multiPathRetrieve } from "../multipath-retrieval.js";
import {
  type RetrievalExtractor,
  ingestRetrievalSource,
  resolveGraphEnrichmentMode,
} from "../retrieval-ingestion.js";

const COLLECTION_ID = "collection_multipath_eval";

class MeaningAwareFixtureProvider implements EmbeddingProviderLike {
  modelId = "test:meaning-aware";
  dimensions = 3;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const lower = text.toLowerCase();
      if (/language test|missandei|pilot rollout/.test(lower)) {
        return Float32Array.from([1, 0, 0]);
      }
      if (/solar|jdk|jvm|java 8/.test(lower)) {
        return Float32Array.from([0, 1, 0]);
      }
      return Float32Array.from([0, 0, 1]);
    });
  }
}

const provider = new MeaningAwareFixtureProvider();
let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
  await db.query("INSERT INTO workspaces (id, handle, name) VALUES ('ws_eval', 'eval', 'Eval')");
  await db.query(
    `INSERT INTO collections (id, handle, owner_id, workspace_id, visibility, data)
     VALUES ($1, 'multipath-eval', 'ws_eval', 'ws_eval', 'private', '{}'::jsonb)`,
    [COLLECTION_ID],
  );
});

describe("Falkor-style retrieval graph ingestion", () => {
  it("defaults graph enrichment to the fast local path", async () => {
    const llmValidate = vi.fn();
    const report = await ingestRetrievalSource(
      db as unknown as QueryClient,
      {
        collectionId: COLLECTION_ID,
        source: "notion",
        externalId: "fast-default",
        content: "Solar is an assessment service.",
      },
      {
        extractor: {
          async extract() {
            return {
              entities: [
                {
                  key: "solar",
                  name: "Solar",
                  type: "service",
                  mentions: [{ chunkIndex: 0 }],
                },
              ],
              relationships: [],
            };
          },
        },
        llmValidator: { validate: llmValidate },
      },
    );

    expect(report.validation).toMatchObject({
      mode: "fast",
      llmApplied: false,
      acceptedEntities: 1,
    });
    expect(llmValidate).not.toHaveBeenCalled();
  });

  it("runs optional LLM validation only when explicitly configured", async () => {
    const llmValidate = vi.fn(async ({ extraction }) => ({
      ...extraction,
      entities: extraction.entities.map((entity) => ({ ...entity, name: "Solar validated" })),
    }));

    const report = await ingestRetrievalSource(
      db as unknown as QueryClient,
      {
        collectionId: COLLECTION_ID,
        source: "notion",
        externalId: "llm-validated",
        content: "Solar validated is an assessment service.",
      },
      {
        graphEnrichmentMode: "llm-validated",
        extractor: {
          async extract() {
            return {
              entities: [
                {
                  key: "solar",
                  name: "Solar",
                  type: "service",
                  mentions: [{ chunkIndex: 0 }],
                },
              ],
              relationships: [],
            };
          },
        },
        llmValidator: { validate: llmValidate },
      },
    );

    expect(llmValidate).toHaveBeenCalledOnce();
    expect(report.validation).toMatchObject({
      mode: "llm-validated",
      llmApplied: true,
      acceptedEntities: 1,
    });
  });

  it("accepts only documented graph-enrichment modes", () => {
    expect(resolveGraphEnrichmentMode(undefined)).toBe("fast");
    expect(resolveGraphEnrichmentMode(" LLM-VALIDATED ")).toBe("llm-validated");
    expect(() => resolveGraphEnrichmentMode("expensive-magic")).toThrow(
      /DOCO_GRAPH_ENRICHMENT_MODE/,
    );
  });

  it("fails clearly when LLM validation is enabled without a validator", async () => {
    await expect(
      ingestRetrievalSource(
        db as unknown as QueryClient,
        {
          collectionId: COLLECTION_ID,
          source: "notion",
          externalId: "missing-validator",
          content: "Solar is an assessment service.",
        },
        {
          graphEnrichmentMode: "llm-validated",
          extractor: {
            async extract() {
              return { entities: [], relationships: [] };
            },
          },
        },
      ),
    ).rejects.toThrow(/requires an llmValidator/);
  });

  it("gives every connector one source-document ingestion path", async () => {
    let extractedChunks: string[] = [];
    const extractor: RetrievalExtractor = {
      async extract({ chunks }) {
        extractedChunks = chunks.map((chunk) => chunk.text);
        return {
          entities: [
            {
              key: "solar",
              name: "Solar",
              type: "service",
              mentions: [{ chunkIndex: 0 }],
            },
          ],
          relationships: [],
        };
      },
    };

    const report = await ingestRetrievalSource(
      db as unknown as QueryClient,
      {
        collectionId: COLLECTION_ID,
        source: "github",
        externalId: "solar/README.md",
        title: "Solar runtime guide",
        content: `Solar is the assessment service.\n\n${"Its build currently targets Java 8. ".repeat(8)}`,
      },
      { extractor, embeddingProvider: provider, chunking: { maxChars: 90, overlapChars: 0 } },
    );

    expect(report.chunkIds.length).toBeGreaterThan(1);
    expect(extractedChunks).toHaveLength(report.chunkIds.length);
    expect(extractedChunks[0]).toContain("Solar");
    expect(report.validation).toMatchObject({
      acceptedEntities: 1,
      rejectedEntities: 0,
      acceptedRelationships: 0,
      rejectedRelationships: 0,
    });
    const rows = await db.query<{ source: string; title: string }>(
      "SELECT source, title FROM retrieval_documents WHERE id = $1",
      [report.documentId],
    );
    expect(rows.rows).toEqual([{ source: "github", title: "Solar runtime guide" }]);
  });

  it("filters an extractor's unsupported claims before graph persistence", async () => {
    const text = "No decision has been made about whether Vega will support the legacy protocol.";
    const report = await ingestRetrievalSource(
      db as unknown as QueryClient,
      {
        collectionId: COLLECTION_ID,
        source: "slack",
        externalId: "C_VEGA:100.2",
        content: text,
      },
      {
        extractor: {
          async extract() {
            return {
              entities: [
                {
                  key: "vega",
                  name: "Vega",
                  type: "service",
                  mentions: [{ chunkIndex: 0 }],
                },
                {
                  key: "protocol",
                  name: "legacy protocol",
                  type: "technology",
                  mentions: [{ chunkIndex: 0 }],
                },
              ],
              relationships: [
                {
                  fromKey: "vega",
                  toKey: "protocol",
                  type: "PROVIDES",
                  fact: text,
                  chunkIndex: 0,
                },
              ],
            };
          },
        },
      },
    );

    expect(report.validation.acceptedEntities).toBe(2);
    expect(report.validation.rejectedRelationships).toBe(1);
    expect(report.validation.issues.map((issue) => issue.code)).toEqual(["uncertain_relationship"]);
    expect(report.relationIds).toEqual([]);
    const relations = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM retrieval_relations WHERE collection_id = $1",
      [COLLECTION_ID],
    );
    expect(relations.rows[0]?.count).toBe(0);
  });

  it("resolves the same typed entity across sources while retaining both mentions", async () => {
    await ingestRetrievalDocument(
      db as unknown as QueryClient,
      {
        collectionId: COLLECTION_ID,
        source: "slack",
        externalId: "C_ENGINEERING:100.1",
        title: "Solar build thread",
        content: "Solar currently builds with JDK 8.",
        chunks: [{ text: "Solar currently builds with JDK 8." }],
        extraction: {
          entities: [
            {
              key: "solar",
              name: "Solar",
              type: "Service",
              mentions: [{ chunkIndex: 0 }],
            },
          ],
          relationships: [],
        },
      },
      { embeddingProvider: provider },
    );
    await ingestRetrievalDocument(
      db as unknown as QueryClient,
      {
        collectionId: COLLECTION_ID,
        source: "notion",
        externalId: "page-solar-runtime",
        title: "Solar runtime",
        content: "The solar-service runtime remains on Java 8.",
        chunks: [{ text: "The solar-service runtime remains on Java 8." }],
        extraction: {
          entities: [
            {
              key: "solar-service",
              name: "solar-service",
              type: "Service",
              aliases: ["Solar"],
              mentions: [{ chunkIndex: 0 }],
            },
          ],
          relationships: [],
        },
      },
      { embeddingProvider: provider },
    );

    const entities = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM retrieval_entities WHERE collection_id = $1",
      [COLLECTION_ID],
    );
    const mentions = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM retrieval_mentions WHERE collection_id = $1",
      [COLLECTION_ID],
    );
    expect(entities.rows[0]?.count).toBe(1);
    expect(mentions.rows[0]?.count).toBe(2);
  });
});

describe("Falkor-style multi-path retrieval", () => {
  it("expands only high-confidence relationships connected to a query entity", async () => {
    await ingestRetrievalDocument(
      db as unknown as QueryClient,
      {
        collectionId: COLLECTION_ID,
        source: "notion",
        externalId: "controlled-expansion",
        content: "Solar uses JDK 8. Solar may use NoiseDB.",
        chunks: [{ text: "Solar uses JDK 8. Solar may use NoiseDB." }],
        extraction: {
          entities: [
            { key: "solar", name: "Solar", type: "service", mentions: [{ chunkIndex: 0 }] },
            { key: "jdk", name: "JDK 8", type: "technology", mentions: [{ chunkIndex: 0 }] },
            { key: "noise", name: "NoiseDB", type: "technology", mentions: [{ chunkIndex: 0 }] },
          ],
          relationships: [
            {
              fromKey: "solar",
              toKey: "jdk",
              type: "USES",
              fact: "Solar uses JDK 8",
              chunkIndex: 0,
              confidence: 0.95,
            },
            {
              fromKey: "solar",
              toKey: "noise",
              type: "USES",
              fact: "Solar may use NoiseDB",
              chunkIndex: 0,
              confidence: 0.71,
            },
          ],
        },
      },
      { embeddingProvider: provider },
    );
    await ingestRetrievalDocument(
      db as unknown as QueryClient,
      {
        collectionId: COLLECTION_ID,
        source: "slack",
        externalId: "jdk-evidence",
        content: "JDK 8 is the production runtime.",
        chunks: [{ text: "JDK 8 is the production runtime." }],
        extraction: {
          entities: [
            { key: "jdk", name: "JDK 8", type: "technology", mentions: [{ chunkIndex: 0 }] },
          ],
          relationships: [],
        },
      },
      { embeddingProvider: provider },
    );
    await ingestRetrievalDocument(
      db as unknown as QueryClient,
      {
        collectionId: COLLECTION_ID,
        source: "slack",
        externalId: "noise-evidence",
        content: "NoiseDB is unrelated background material.",
        chunks: [{ text: "NoiseDB is unrelated background material." }],
        extraction: {
          entities: [
            { key: "noise", name: "NoiseDB", type: "technology", mentions: [{ chunkIndex: 0 }] },
          ],
          relationships: [],
        },
      },
      { embeddingProvider: provider },
    );

    const [queryEmbedding] = await provider.embed(["What runtime does Solar use?"], "query");
    const result = await multiPathRetrieve(db as unknown as QueryClient, {
      collectionId: COLLECTION_ID,
      queryText: "What runtime does Solar use?",
      semantic: { queryEmbedding, modelId: provider.modelId },
      accessScopes: ["workspace"],
      limit: 10,
      minimumRelationshipConfidence: 0.8,
    });

    expect(result.items.find((item) => item.externalId === "jdk-evidence")?.paths).toContain(
      "neighbor_mention",
    );
    expect(
      result.items.find((item) => item.externalId === "noise-evidence")?.paths ?? [],
    ).not.toContain("neighbor_mention");

    const directOnly = await multiPathRetrieve(db as unknown as QueryClient, {
      collectionId: COLLECTION_ID,
      queryText: "What runtime does Solar use?",
      semantic: { queryEmbedding, modelId: provider.modelId },
      accessScopes: ["workspace"],
      limit: 10,
      maxEntities: 0,
      maxRelationships: 0,
      relationshipVectorLimit: 0,
      maxHops: 0,
    });

    expect(directOnly.stats.entitySeeds).toBe(0);
    expect(directOnly.stats.relationshipsExpanded).toBe(0);
    expect(
      directOnly.items
        .flatMap((item) => item.paths)
        .filter((path) => ["entity_mention", "neighbor_mention", "graph_relation"].includes(path)),
    ).toEqual([]);
  });

  it("uses a code-name relationship to retrieve status evidence from another document", async () => {
    await ingestRetrievalDocument(
      db as unknown as QueryClient,
      {
        collectionId: COLLECTION_ID,
        source: "notion",
        externalId: "language-testing-glossary",
        title: "Language testing glossary",
        content: "The language testing initiative is code-named chore-missandei.",
        chunks: [{ text: "The language testing initiative is code-named chore-missandei." }],
        extraction: {
          entities: [
            {
              key: "language-tests",
              name: "language tests",
              type: "Capability",
              mentions: [{ chunkIndex: 0 }],
            },
            {
              key: "missandei",
              name: "chore-missandei",
              type: "Effort",
              mentions: [{ chunkIndex: 0 }],
            },
          ],
          relationships: [
            {
              fromKey: "missandei",
              toKey: "language-tests",
              type: "CODENAME_FOR",
              fact: "chore-missandei is the code name for the language testing initiative",
              chunkIndex: 0,
            },
          ],
        },
      },
      { embeddingProvider: provider },
    );
    await ingestRetrievalDocument(
      db as unknown as QueryClient,
      {
        collectionId: COLLECTION_ID,
        source: "slack",
        externalId: "C_MISSANDEI:200.2",
        title: "Rollout update",
        content: "Chore-missandei has entered a pilot rollout with three teams.",
        chunks: [{ text: "Chore-missandei has entered a pilot rollout with three teams." }],
        extraction: {
          entities: [
            {
              key: "missandei",
              name: "chore-missandei",
              type: "Effort",
              mentions: [{ chunkIndex: 0 }],
            },
          ],
          relationships: [],
        },
      },
      { embeddingProvider: provider },
    );
    await ingestRetrievalDocument(
      db as unknown as QueryClient,
      {
        collectionId: COLLECTION_ID,
        source: "notion",
        externalId: "translation-distractor",
        title: "Translation settings",
        content: "Users can change the interface language in account settings.",
        chunks: [{ text: "Users can change the interface language in account settings." }],
        extraction: { entities: [], relationships: [] },
      },
      { embeddingProvider: provider },
    );
    await ingestRetrievalDocument(db as unknown as QueryClient, {
      collectionId: COLLECTION_ID,
      source: "notion",
      externalId: "language-testing-haystack",
      title: "Language testing archive",
      content: "Archived language-testing meeting notes.",
      chunks: Array.from({ length: 120 }, (_, index) => ({
        text: `Language tests archive note ${index}: routine translation discussion with no rollout status.`,
      })),
      extraction: { entities: [], relationships: [] },
    });

    const [queryEmbedding] = await provider.embed(
      ["What is the status of language tests in Torre?"],
      "query",
    );
    const result = await multiPathRetrieve(db as unknown as QueryClient, {
      collectionId: COLLECTION_ID,
      queryText: "What is the status of language tests in Torre?",
      keywords: ["language tests"],
      semantic: { queryEmbedding, modelId: provider.modelId },
      accessScopes: ["workspace"],
      limit: 5,
    });

    const statusIndex = result.items.findIndex((item) => item.externalId === "C_MISSANDEI:200.2");
    expect(statusIndex).toBeGreaterThanOrEqual(0);
    expect(statusIndex).toBeLessThan(3);
    const status = result.items[statusIndex];
    expect(status?.paths).toContain("neighbor_mention");
    expect(result.stats.relationshipsExpanded).toBeGreaterThan(0);
  });

  it("retrieves the Solar JDK evidence through relationship and chunk vectors", async () => {
    await ingestRetrievalDocument(
      db as unknown as QueryClient,
      {
        collectionId: COLLECTION_ID,
        source: "code",
        externalId: "solar/.github/workflows/build.yml",
        title: "Solar CI build",
        content: "Solar CI installs Temurin JDK 8 before running the build.",
        chunks: [{ text: "Solar CI installs Temurin JDK 8 before running the build." }],
        extraction: {
          entities: [
            {
              key: "solar",
              name: "Solar",
              type: "Service",
              mentions: [{ chunkIndex: 0 }],
            },
            {
              key: "jdk8",
              name: "JDK 8",
              type: "Technology",
              aliases: ["Java 8"],
              mentions: [{ chunkIndex: 0 }],
            },
          ],
          relationships: [
            {
              fromKey: "solar",
              toKey: "jdk8",
              type: "USES",
              fact: "Solar uses JDK 8",
              chunkIndex: 0,
            },
          ],
        },
      },
      { embeddingProvider: provider },
    );

    const [queryEmbedding] = await provider.embed(["Which JVM version does Solar use?"], "query");
    const result = await multiPathRetrieve(db as unknown as QueryClient, {
      collectionId: COLLECTION_ID,
      queryText: "Which JVM version does Solar use?",
      keywords: ["Solar", "JVM"],
      semantic: { queryEmbedding, modelId: provider.modelId },
      accessScopes: ["workspace"],
      limit: 5,
    });

    expect(result.items[0]?.externalId).toBe("solar/.github/workflows/build.yml");
    expect(result.items[0]?.text).toContain("JDK 8");
    expect(result.items[0]?.paths).toContain("relationship_vector");

    const lexicalOnly = await multiPathRetrieve(db as unknown as QueryClient, {
      collectionId: COLLECTION_ID,
      queryText: "Which JVM version does Solar use?",
      semantic: null,
      accessScopes: ["workspace"],
      limit: 5,
    });
    expect(lexicalOnly.items[0]?.externalId).toBe("solar/.github/workflows/build.yml");
  });

  it("does not traverse or return evidence outside the caller's access scopes", async () => {
    await ingestRetrievalDocument(
      db as unknown as QueryClient,
      {
        collectionId: COLLECTION_ID,
        source: "slack",
        externalId: "C_PRIVATE:300.3",
        title: "Private Raven thread",
        content: "Project Raven will acquire the confidential target on Friday.",
        accessScopes: ["slack:C_PRIVATE"],
        chunks: [{ text: "Project Raven will acquire the confidential target on Friday." }],
        extraction: {
          entities: [
            {
              key: "raven",
              name: "Project Raven",
              type: "Effort",
              mentions: [{ chunkIndex: 0 }],
            },
          ],
          relationships: [],
        },
      },
      { embeddingProvider: provider },
    );

    const result = await multiPathRetrieve(db as unknown as QueryClient, {
      collectionId: COLLECTION_ID,
      queryText: "What is Project Raven?",
      keywords: ["Project Raven"],
      semantic: null,
      accessScopes: ["workspace"],
      limit: 5,
    });

    expect(result.items).toEqual([]);
  });
});
