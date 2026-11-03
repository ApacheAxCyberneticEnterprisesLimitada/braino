import { describe, expect, it, vi } from "vitest";
import { LocalNlpRetrievalExtractor } from "../local-nlp-retrieval-extractor.js";
import { OllamaRetrievalExtractor } from "../ollama-retrieval-extractor.js";
import { configuredRetrievalExtractor } from "../retrieval-extractor.js";

const DOCUMENT = {
  collectionId: "collection_test",
  source: "code",
  externalId: "torre/solar:README.md",
  title: "Solar",
  content: "Solar uses JDK 8.",
};

function ollamaResponse(content: unknown): Response {
  return new Response(
    JSON.stringify({
      message: { content: JSON.stringify(content) },
      done: true,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("OllamaRetrievalExtractor", () => {
  it("accepts an evidence-grounded relationship type that was not predefined", async () => {
    const fetchImpl = vi.fn(async () =>
      ollamaResponse({
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
    const extractor = new OllamaRetrievalExtractor({ fetchImpl });

    const extraction = await extractor.extract({
      document: { ...DOCUMENT, content: "Northstar acquired Radar in 2025." },
      chunks: [{ text: "Northstar acquired Radar in 2025." }],
    });

    expect(extraction.relationships).toEqual([expect.objectContaining({ type: "ACQUIRED" })]);
  });

  it("uses a local Qwen 8B model and turns grounded model output into graph input", async () => {
    const fetchImpl = vi.fn(async () =>
      ollamaResponse({
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
    const extractor = new OllamaRetrievalExtractor({ fetchImpl, apiToken: "test-graph-token" });

    const extraction = await extractor.extract({
      document: DOCUMENT,
      chunks: [{ text: DOCUMENT.content, breadcrumb: "Solar" }],
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:11434/api/chat");
    const request = JSON.parse(String(init?.body));
    expect(request).toMatchObject({
      model: "qwen3:8b",
      stream: false,
      think: false,
      options: { temperature: 0, seed: 42 },
    });
    expect(init?.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer test-graph-token",
    });
    expect(request.format.properties.entities.items.properties.type.enum).toContain("service");
    expect(request.format.properties.relationships.items.properties.type).toMatchObject({
      pattern: "^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){0,7}$",
      maxLength: 80,
    });
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
        ollamaResponse({
          entities: [{ name: "Radar", type: "service", aliases: [], confidence: 0.9 }],
          relationships: [],
        }),
      )
      .mockResolvedValueOnce(
        ollamaResponse({
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
    const extractor = new OllamaRetrievalExtractor({ fetchImpl });

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

  it("uses local NLP unless the retrieval workload has its own Ollama model", () => {
    expect(configuredRetrievalExtractor({})).toBeInstanceOf(LocalNlpRetrievalExtractor);
    expect(
      configuredRetrievalExtractor({
        DOCO_GRAPH_EXTRACTION_MODEL: "qwen3:8b",
      }),
    ).toBeInstanceOf(LocalNlpRetrievalExtractor);
    expect(
      configuredRetrievalExtractor({
        DOCO_RETRIEVAL_EXTRACTION_MODEL: "qwen3:8b",
      }),
    ).toBeInstanceOf(OllamaRetrievalExtractor);
  });

  it("fails clearly when Ollama returns invalid structured output", async () => {
    const fetchImpl = vi.fn(async () => ollamaResponse({ entities: "wrong" }));
    const extractor = new OllamaRetrievalExtractor({ fetchImpl });

    await expect(
      extractor.extract({ document: DOCUMENT, chunks: [{ text: DOCUMENT.content }] }),
    ).rejects.toThrow(/invalid graph extraction/i);
  });
});
