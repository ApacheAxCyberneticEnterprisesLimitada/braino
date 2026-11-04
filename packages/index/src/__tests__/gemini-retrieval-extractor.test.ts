import { describe, expect, it, vi } from "vitest";
import { GeminiRetrievalExtractor } from "../gemini-retrieval-extractor.js";
import { LocalNlpRetrievalExtractor } from "../local-nlp-retrieval-extractor.js";
import { configuredRetrievalExtractor } from "../retrieval-extractor.js";

const DOCUMENT = {
  collectionId: "collection_test",
  source: "code",
  externalId: "torre/solar:README.md",
  title: "Solar",
  content: "Solar uses JDK 8.",
};

function openRouterResponse(content: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
      usage: { prompt_tokens: 12, completion_tokens: 7 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("GeminiRetrievalExtractor", () => {
  it("accepts an evidence-grounded relationship type that was not predefined", async () => {
    const fetchImpl = vi.fn(async () =>
      openRouterResponse({
        entities: [
          { name: "Northstar", type: "product", aliases: [], confidence: 0.98 },
          { name: "Radar", type: "service", aliases: [], confidence: 0.96 },
        ],
        relationships: [
          {
            from: "Northstar",
            to: "Radar",
            type: "ACQUIRED",
            evidence: "Northstar acquired Radar in 2025.",
            confidence: 0.95,
          },
        ],
      }),
    );
    const extractor = new GeminiRetrievalExtractor({ fetchImpl });

    const extraction = await extractor.extract({
      document: { ...DOCUMENT, content: "Northstar acquired Radar in 2025." },
      chunks: [{ text: "Northstar acquired Radar in 2025." }],
    });

    expect(extraction.relationships).toEqual([expect.objectContaining({ type: "ACQUIRED" })]);
  });

  it("uses Gemini through OpenRouter and turns grounded model output into graph input", async () => {
    const fetchImpl = vi.fn(async () =>
      openRouterResponse({
        entities: [
          { name: "Solar", type: "service", aliases: [], confidence: 0.98 },
          { name: "JDK 8", type: "technology", aliases: [], confidence: 0.96 },
        ],
        relationships: [
          {
            from: "Solar",
            to: "JDK 8",
            type: "USES",
            evidence: "Solar uses JDK 8.",
            confidence: 0.95,
          },
        ],
      }),
    );
    const extractor = new GeminiRetrievalExtractor({
      fetchImpl,
      apiToken: "test-graph-token",
    });

    const extraction = await extractor.extract({
      document: DOCUMENT,
      chunks: [{ text: DOCUMENT.content, breadcrumb: "Solar" }],
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const request = JSON.parse(String(init?.body));
    expect(request).toMatchObject({
      model: "google/gemini-3.5-flash-lite",
      stream: false,
      temperature: 0,
      max_tokens: 2048,
      reasoning: { effort: "minimal" },
      provider: { require_parameters: true, data_collection: "deny" },
      response_format: {
        type: "json_schema",
        json_schema: { name: "retrieval_graph", strict: true },
      },
    });
    expect(init?.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer test-graph-token",
    });
    expect(
      request.response_format.json_schema.schema.properties.entities.items.properties.type.enum,
    ).toContain("service");
    expect(
      request.response_format.json_schema.schema.properties.relationships.items.properties.type,
    ).toEqual({ type: "string" });
    expect(request.messages[0].content).toContain("Predicates are open");
    expect(request.messages[1].content).toContain("Solar uses JDK 8.");
    expect(request.messages[1].content).toContain("Leila -FOUNDED-> Northstar");
    expect(extraction).toEqual({
      entities: [
        {
          key: "chunk-0:entity-0",
          name: "Solar",
          type: "service",
          aliases: [],
          mentions: [{ chunkIndex: 0, confidence: 0.98 }],
        },
        {
          key: "chunk-0:entity-1",
          name: "JDK 8",
          type: "technology",
          aliases: [],
          mentions: [{ chunkIndex: 0, confidence: 0.96 }],
        },
      ],
      relationships: [
        {
          fromKey: "chunk-0:entity-0",
          toKey: "chunk-0:entity-1",
          type: "USES",
          fact: "Solar uses JDK 8.",
          chunkIndex: 0,
          confidence: 0.95,
        },
      ],
    });
  });

  it("extracts each chunk independently so evidence cannot point at the wrong chunk", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        openRouterResponse({
          entities: [{ name: "Radar", type: "service", aliases: [], confidence: 0.9 }],
          relationships: [],
        }),
      )
      .mockResolvedValueOnce(
        openRouterResponse({
          entities: [
            {
              name: "Radar",
              type: "service",
              aliases: [],
              confidence: 0.91,
            },
          ],
          relationships: [],
        }),
      );
    const extractor = new GeminiRetrievalExtractor({ fetchImpl });

    const extraction = await extractor.extract({
      document: { ...DOCUMENT, content: "Radar is active.\nRadar handles alerts." },
      chunks: [{ text: "Radar is active." }, { text: "Radar handles alerts." }],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(extraction.entities.map((entity) => entity.key)).toEqual([
      "chunk-0:entity-0",
      "chunk-1:entity-0",
    ]);
    expect(extraction.entities.map((entity) => entity.mentions[0].chunkIndex)).toEqual([0, 1]);
  });

  it("uses local NLP until OpenRouter is configured", () => {
    expect(configuredRetrievalExtractor({})).toBeInstanceOf(LocalNlpRetrievalExtractor);
    expect(
      configuredRetrievalExtractor({
        OPENROUTER_API_KEY: "router-secret",
      }),
    ).toBeInstanceOf(GeminiRetrievalExtractor);
  });

  it("fails clearly when Gemini returns invalid structured output", async () => {
    const fetchImpl = vi.fn(async () => openRouterResponse({ entities: "wrong" }));
    const extractor = new GeminiRetrievalExtractor({ fetchImpl });

    await expect(
      extractor.extract({ document: DOCUMENT, chunks: [{ text: DOCUMENT.content }] }),
    ).rejects.toThrow(/invalid graph extraction/i);
  });
});
