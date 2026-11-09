import { describe, expect, it, vi } from "vitest";
import { QdrantVectorStore, type VectorRecord, qdrantPointId } from "../qdrant-vector-store.js";

function record(overrides: Partial<VectorRecord> = {}): VectorRecord {
  return {
    collection_id: "collection_alpha",
    source: "node",
    entity_id: "decision_alpha",
    chunk_index: 0,
    model_id: "test:model",
    content_hash: "hash-alpha",
    chunk_text: "Alpha uses Java 21.",
    embedding: [1, 0],
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("QdrantVectorStore", () => {
  it("checks Qdrant readiness with the configured API key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("all shards are ready"));
    const store = new QdrantVectorStore({
      url: "http://qdrant:6333/",
      apiKey: "secret",
      fetch: fetchMock as typeof fetch,
    });

    await store.assertReady();

    expect(fetchMock).toHaveBeenCalledWith("http://qdrant:6333/readyz", {
      headers: { "api-key": "secret", "content-type": "application/json" },
      signal: expect.any(AbortSignal),
    });
  });

  it("rejects a failed Qdrant readiness response", async () => {
    const store = new QdrantVectorStore({
      url: "http://qdrant:6333",
      fetch: vi.fn().mockResolvedValue(new Response("not ready", { status: 503 })) as typeof fetch,
    });

    await expect(store.assertReady()).rejects.toThrow("Qdrant GET /readyz failed (503)");
  });

  it("retries collection initialization after a transient Qdrant failure", async () => {
    let collectionReads = 0;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        collectionReads += 1;
        return collectionReads === 1
          ? new Response("starting", { status: 503 })
          : json({ status: "not found" }, 404);
      }
      return json({ result: true, status: "ok" });
    });
    const store = new QdrantVectorStore({
      url: "http://qdrant:6333",
      dimensions: 2,
      fetch: fetchMock as typeof fetch,
    });

    await expect(store.upsert([record()])).rejects.toThrow("failed (503)");
    await expect(store.upsert([record()])).resolves.toBeUndefined();
    expect(collectionReads).toBe(2);
  });

  it("uses a stable UUID per collection/entity/chunk and replaces model changes in place", () => {
    const first = qdrantPointId(record());
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(qdrantPointId(record({ model_id: "new:model" }))).toBe(first);
    expect(qdrantPointId(record({ chunk_index: 1 }))).not.toBe(first);
  });

  it("creates an indexed collection and stores padded vectors with filterable payload", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (!init?.method || init.method === "GET") return json({ status: "not found" }, 404);
      return json({ result: true, status: "ok" });
    });
    const store = new QdrantVectorStore({
      url: "http://qdrant:6333/",
      dimensions: 4,
      fetch: fetchMock as typeof fetch,
    });

    await store.upsert([record()]);

    const create = requests.find(
      (request) =>
        request.url.endsWith("/collections/doco_embeddings") && request.init?.method === "PUT",
    );
    expect(JSON.parse(String(create?.init?.body))).toMatchObject({
      vectors: { size: 4, distance: "Cosine", on_disk: true },
      hnsw_config: { on_disk: true },
    });
    const upsert = requests.find((request) => request.url.includes("/points?wait=true"));
    expect(JSON.parse(String(upsert?.init?.body))).toEqual({
      points: [
        {
          id: qdrantPointId(record()),
          vector: [1, 0, 0, 0],
          payload: {
            collection_id: "collection_alpha",
            source: "node",
            entity_id: "decision_alpha",
            entity_key: "collection_alpha\ndecision_alpha",
            chunk_index: 0,
            model_id: "test:model",
            content_hash: "hash-alpha",
            chunk_text: "Alpha uses Java 21.",
          },
        },
      ],
    });
    expect(requests.every((request) => request.init?.signal instanceof AbortSignal)).toBe(true);
    await expect(store.ensureCollection()).resolves.toEqual({ created: true });
    await expect(store.ensureCollection()).resolves.toEqual({ created: false });
  });

  it("ranks one best chunk per entity inside the authorized collections and model", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (!init?.method || init.method === "GET") {
        return json({
          result: {
            config: { params: { vectors: { size: 4, distance: "Cosine" } } },
            payload_schema: {
              collection_id: {},
              source: {},
              entity_id: {},
              entity_key: {},
              model_id: {},
            },
          },
          status: "ok",
        });
      }
      if (String(input).includes("/points/query/groups")) {
        return json({
          result: {
            groups: [
              {
                id: "collection_alpha\ndecision_alpha",
                hits: [
                  {
                    score: 0.93,
                    payload: {
                      collection_id: "collection_alpha",
                      entity_id: "decision_alpha",
                      chunk_text: "Alpha uses Java 21.",
                    },
                  },
                ],
              },
            ],
          },
          status: "ok",
        });
      }
      return json({ result: true, status: "ok" });
    });
    const store = new QdrantVectorStore({
      url: "http://qdrant:6333",
      dimensions: 4,
      fetch: fetchMock as typeof fetch,
    });

    const hits = await store.rank({
      collectionIds: ["collection_alpha", "collection_beta"],
      source: "node",
      modelId: "test:model",
      queryEmbedding: [1, 0],
      entityIds: ["decision_alpha"],
      limit: 5,
    });

    expect(hits).toEqual([
      {
        collection_id: "collection_alpha",
        entity_id: "decision_alpha",
        chunk_text: "Alpha uses Java 21.",
        score: 0.93,
      },
    ]);
    const query = requests.find((request) => request.url.includes("/points/query/groups"));
    expect(JSON.parse(String(query?.init?.body))).toMatchObject({
      query: [1, 0, 0, 0],
      group_by: "entity_key",
      group_size: 1,
      limit: 5,
      filter: {
        must: [
          { key: "collection_id", match: { any: ["collection_alpha", "collection_beta"] } },
          { key: "source", match: { value: "node" } },
          { key: "model_id", match: { value: "test:model" } },
          { key: "entity_id", match: { any: ["decision_alpha"] } },
        ],
      },
    });
  });

  it("indexes chunk text for BM25 and ranks one lexical match per entity", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (!init?.method || init.method === "GET") {
        return json({
          result: {
            config: { params: { vectors: { size: 4, distance: "Cosine" } } },
            payload_schema: {
              collection_id: {},
              source: {},
              entity_id: {},
              entity_key: {},
              model_id: {},
            },
          },
        });
      }
      if (String(input).includes("/points/query/groups")) {
        return json({
          result: {
            groups: [
              {
                hits: [
                  {
                    score: 4.2,
                    payload: {
                      collection_id: "collection_alpha",
                      entity_id: "decision_alpha",
                      chunk_text: "Alpha uses Java 21.",
                    },
                  },
                ],
              },
            ],
          },
        });
      }
      return json({ result: true, status: "ok" });
    });
    const store = new QdrantVectorStore({
      url: "http://qdrant:6333",
      dimensions: 4,
      fetch: fetchMock as typeof fetch,
    });

    const hits = await store.rankLexical({
      collectionIds: ["collection_alpha"],
      source: "node",
      queryText: "Which Java version does Alpha use?",
      entityIds: ["decision_alpha"],
      limit: 5,
    });

    const textIndex = requests.find((request) => {
      if (!request.url.endsWith("/collections/doco_embeddings/index?wait=true")) return false;
      return JSON.parse(String(request.init?.body)).field_name === "chunk_text";
    });
    expect(JSON.parse(String(textIndex?.init?.body))).toEqual({
      field_name: "chunk_text",
      field_schema: {
        type: "text",
        tokenizer: "word",
        lowercase: true,
        stemmer: { type: "snowball", language: "english" },
        stopwords: "english",
        scoring: { type: "bm25" },
      },
    });
    const query = requests.find((request) => request.url.includes("/points/query/groups"));
    expect(JSON.parse(String(query?.init?.body))).toMatchObject({
      query: { text: "Which Java version does Alpha use?" },
      using: "chunk_text",
      filter: {
        must: [
          { key: "collection_id", match: { any: ["collection_alpha"] } },
          { key: "source", match: { value: "node" } },
          { key: "entity_id", match: { any: ["decision_alpha"] } },
        ],
      },
      group_by: "entity_key",
      group_size: 1,
      limit: 5,
      with_payload: true,
    });
    expect(hits).toEqual([
      {
        collection_id: "collection_alpha",
        entity_id: "decision_alpha",
        chunk_text: "Alpha uses Java 21.",
        score: 4.2,
      },
    ]);
  });

  it("does not issue broad searches or deletes for empty scopes", async () => {
    const fetchMock = vi.fn();
    const store = new QdrantVectorStore({
      url: "http://qdrant:6333",
      dimensions: 4,
      fetch: fetchMock as typeof fetch,
    });

    expect(
      await store.rank({
        collectionIds: [],
        source: "node",
        modelId: "test:model",
        queryEmbedding: [1, 0],
        limit: 5,
      }),
    ).toEqual([]);
    await store.delete({ collectionIds: [], source: "node" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deletes exact chunk points without widening their scope", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (!init?.method || init.method === "GET") {
        return json({
          result: {
            config: { params: { vectors: { size: 4, distance: "Cosine" } } },
            payload_schema: {
              collection_id: {},
              source: {},
              entity_id: {},
              entity_key: {},
              model_id: {},
            },
          },
        });
      }
      return json({ result: true, status: "ok" });
    });
    const store = new QdrantVectorStore({
      url: "http://qdrant:6333",
      dimensions: 4,
      fetch: fetchMock as typeof fetch,
    });

    await store.deletePoints([
      { collection_id: "collection_alpha", entity_id: "decision_alpha", chunk_index: 0 },
      { collection_id: "collection_alpha", entity_id: "decision_alpha", chunk_index: 2 },
    ]);

    const request = requests.find((candidate) => candidate.url.includes("/points/delete"));
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      points: [qdrantPointId(record()), qdrantPointId(record({ chunk_index: 2 }))],
    });
  });
});
