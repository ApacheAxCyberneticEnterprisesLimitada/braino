import { createHash } from "node:crypto";
import type { EmbeddingHit, EmbeddingSource } from "@doco/db";

const DEFAULT_COLLECTION = "doco_embeddings";
const DEFAULT_DIMENSIONS = 1536;
const UPSERT_BATCH = 256;
/** The HNSW graph each Qdrant collection is built with. */
export const QDRANT_HNSW = { m: 32, ef_construct: 200 } as const;
const UUID_NAMESPACE = Buffer.from("d0c00000000050008000000000000001", "hex");

export interface VectorRecord {
  collection_id: string;
  source: EmbeddingSource;
  entity_id: string;
  chunk_index: number;
  model_id: string;
  content_hash: string;
  chunk_text: string;
  embedding: ArrayLike<number>;
}

export interface VectorRankArgs {
  collectionIds: string[];
  source: EmbeddingSource;
  modelId: string;
  queryEmbedding: ArrayLike<number>;
  limit: number;
  entityIds?: string[] | null;
}

export interface LexicalRankArgs {
  collectionIds: string[];
  source: EmbeddingSource;
  queryText: string;
  limit: number;
  entityIds?: string[] | null;
}

export interface VectorDeleteArgs {
  collectionIds: string[];
  source?: EmbeddingSource;
  entityIds?: string[];
}

export interface VectorPointKey {
  collection_id: string;
  entity_id: string;
  chunk_index: number;
}

/** Derived vector-index boundary. PostgreSQL remains the source of truth. */
export interface VectorStore {
  ensureCollection?(): Promise<{ created: boolean }>;
  upsert(records: VectorRecord[]): Promise<void>;
  delete(args: VectorDeleteArgs): Promise<void>;
  deletePoints(points: VectorPointKey[]): Promise<void>;
  rank(args: VectorRankArgs): Promise<EmbeddingHit[]>;
}

export interface LexicalStore {
  rankLexical(args: LexicalRankArgs): Promise<EmbeddingHit[]>;
}

export type RetrievalStore = VectorStore & LexicalStore;

export interface QdrantVectorStoreOptions {
  url: string;
  apiKey?: string;
  collection?: string;
  dimensions?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface QdrantCollectionInfo {
  config?: { params?: { vectors?: { size?: number; distance?: string } } };
  payload_schema?: Record<string, unknown>;
}

interface QdrantResponse<T> {
  result: T;
  status?: string;
}

interface QdrantGroupHit {
  score: number;
  payload?: {
    collection_id?: string;
    entity_id?: string;
    chunk_text?: string;
  };
}

interface QdrantGroup {
  hits?: QdrantGroupHit[];
}

function padVector(vector: ArrayLike<number>, dimensions: number): number[] {
  const padded = new Array<number>(dimensions).fill(0);
  const length = Math.min(vector.length, dimensions);
  for (let index = 0; index < length; index++) {
    const value = Number(vector[index]);
    if (!Number.isFinite(value))
      throw new Error(`Vector contains a non-finite value at index ${index}.`);
    padded[index] = value;
  }
  return padded;
}

/**
 * Qdrant accepts integer or UUID point ids. Braino ids are neither, so derive a
 * stable UUIDv5 from the same key as Postgres' embedding primary key.
 */
export function qdrantPointId(
  record: Pick<VectorRecord, "collection_id" | "entity_id" | "chunk_index">,
): string {
  const name = `${record.collection_id}\n${record.entity_id}\n${record.chunk_index}`;
  const bytes = createHash("sha1").update(UUID_NAMESPACE).update(name).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function qdrantFilter(
  args: VectorDeleteArgs | VectorRankArgs | LexicalRankArgs,
): Record<string, unknown> {
  const must: Record<string, unknown>[] = [
    { key: "collection_id", match: { any: args.collectionIds } },
  ];
  if (args.source) must.push({ key: "source", match: { value: args.source } });
  if ("modelId" in args) must.push({ key: "model_id", match: { value: args.modelId } });
  if (args.entityIds) must.push({ key: "entity_id", match: { any: args.entityIds } });
  return { must };
}

function embeddingHits(result: { groups?: QdrantGroup[] }): EmbeddingHit[] {
  const hits: EmbeddingHit[] = [];
  for (const group of result.groups ?? []) {
    const hit = group.hits?.[0];
    const payload = hit?.payload;
    if (
      !hit ||
      typeof payload?.collection_id !== "string" ||
      typeof payload.entity_id !== "string" ||
      typeof payload.chunk_text !== "string"
    ) {
      continue;
    }
    hits.push({
      collection_id: payload.collection_id,
      entity_id: payload.entity_id,
      chunk_text: payload.chunk_text,
      score: Number(hit.score),
    });
  }
  return hits;
}

export class QdrantVectorStore implements RetrievalStore {
  private readonly url: string;
  private readonly apiKey: string | undefined;
  private readonly collection: string;
  private readonly dimensions: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private ready: Promise<void> | undefined;
  private collectionCreated = false;

  constructor(options: QdrantVectorStoreOptions) {
    this.url = options.url.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.collection = options.collection ?? DEFAULT_COLLECTION;
    this.dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchImpl = options.fetch ?? fetch;
    if (!this.url) throw new Error("Qdrant URL is required.");
    if (!Number.isInteger(this.dimensions) || this.dimensions < 1) {
      throw new Error("Qdrant vector dimensions must be a positive integer.");
    }
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error("Qdrant request timeout must be a positive integer.");
    }
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.apiKey ? { "api-key": this.apiKey } : {}),
    };
  }

  /** Verify that Qdrant can accept traffic without touching collection data. */
  async assertReady(): Promise<void> {
    const response = await this.fetchImpl(`${this.url}/readyz`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Qdrant GET /readyz failed (${response.status})`);
    }
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.url}${path}`, {
      ...init,
      headers: { ...this.headers(), ...init.headers },
      signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(
        `Qdrant ${init.method ?? "GET"} ${path} failed (${response.status}): ${await response.text()}`,
      );
    }
    return ((await response.json()) as QdrantResponse<T>).result;
  }

  private async ensureReady(): Promise<void> {
    if (!this.ready) {
      const initializing = this.initialize();
      this.ready = initializing;
      void initializing.catch(() => {
        if (this.ready === initializing) this.ready = undefined;
      });
    }
    return this.ready;
  }

  /** Ensure indexes exist and report a newly created/incomplete collection once. */
  async ensureCollection(): Promise<{ created: boolean }> {
    await this.ensureReady();
    const created = this.collectionCreated;
    this.collectionCreated = false;
    return { created };
  }

  private async initialize(): Promise<void> {
    const path = `/collections/${encodeURIComponent(this.collection)}`;
    const response = await this.fetchImpl(`${this.url}${path}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let info: QdrantCollectionInfo;
    let created = false;
    if (response.status === 404) {
      await this.request(path, {
        method: "PUT",
        body: JSON.stringify({
          vectors: { size: this.dimensions, distance: "Cosine", on_disk: true },
          hnsw_config: { ...QDRANT_HNSW, on_disk: true },
          on_disk_payload: true,
        }),
      });
      info = { payload_schema: {} };
      created = true;
    } else {
      if (!response.ok) {
        throw new Error(`Qdrant GET ${path} failed (${response.status}): ${await response.text()}`);
      }
      info = ((await response.json()) as QdrantResponse<QdrantCollectionInfo>).result;
      const size = info.config?.params?.vectors?.size;
      if (size !== this.dimensions) {
        throw new Error(
          `Qdrant collection ${this.collection} has ${String(size)} dimensions; expected ${this.dimensions}. Rebuild the derived collection before switching models.`,
        );
      }
    }

    const schemas: Record<string, unknown> = {
      collection_id: { type: "keyword", is_tenant: true },
      source: "keyword",
      entity_id: "keyword",
      entity_key: "keyword",
      model_id: "keyword",
      chunk_text: {
        type: "text",
        tokenizer: "word",
        lowercase: true,
        stemmer: { type: "snowball", language: "english" },
        stopwords: "english",
        scoring: { type: "bm25" },
      },
    };
    const existing = info.payload_schema ?? {};
    created ||= !("entity_key" in existing) || !("chunk_text" in existing);
    for (const [fieldName, fieldSchema] of Object.entries(schemas)) {
      if (fieldName in existing) continue;
      await this.request(`${path}/index?wait=true`, {
        method: "PUT",
        body: JSON.stringify({ field_name: fieldName, field_schema: fieldSchema }),
      });
    }
    this.collectionCreated ||= created;
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.ensureReady();
    const path = `/collections/${encodeURIComponent(this.collection)}/points?wait=true`;
    for (let offset = 0; offset < records.length; offset += UPSERT_BATCH) {
      const batch = records.slice(offset, offset + UPSERT_BATCH);
      await this.request(path, {
        method: "PUT",
        body: JSON.stringify({
          points: batch.map((record) => ({
            id: qdrantPointId(record),
            vector: padVector(record.embedding, this.dimensions),
            payload: {
              collection_id: record.collection_id,
              source: record.source,
              entity_id: record.entity_id,
              entity_key: `${record.collection_id}\n${record.entity_id}`,
              chunk_index: record.chunk_index,
              model_id: record.model_id,
              content_hash: record.content_hash,
              chunk_text: record.chunk_text,
            },
          })),
        }),
      });
    }
  }

  async delete(args: VectorDeleteArgs): Promise<void> {
    if (args.collectionIds.length === 0 || (args.entityIds && args.entityIds.length === 0)) return;
    await this.ensureReady();
    await this.request(
      `/collections/${encodeURIComponent(this.collection)}/points/delete?wait=true`,
      {
        method: "POST",
        body: JSON.stringify({ filter: qdrantFilter(args) }),
      },
    );
  }

  async deletePoints(points: VectorPointKey[]): Promise<void> {
    if (points.length === 0) return;
    await this.ensureReady();
    await this.request(
      `/collections/${encodeURIComponent(this.collection)}/points/delete?wait=true`,
      {
        method: "POST",
        body: JSON.stringify({ points: points.map((point) => qdrantPointId(point)) }),
      },
    );
  }

  async rank(args: VectorRankArgs): Promise<EmbeddingHit[]> {
    if (
      args.collectionIds.length === 0 ||
      args.limit <= 0 ||
      (args.entityIds && args.entityIds.length === 0)
    ) {
      return [];
    }
    await this.ensureReady();
    const result = await this.request<{ groups?: QdrantGroup[] }>(
      `/collections/${encodeURIComponent(this.collection)}/points/query/groups`,
      {
        method: "POST",
        body: JSON.stringify({
          query: padVector(args.queryEmbedding, this.dimensions),
          filter: qdrantFilter(args),
          group_by: "entity_key",
          group_size: 1,
          limit: args.limit,
          with_payload: true,
        }),
      },
    );
    return embeddingHits(result);
  }

  async rankLexical(args: LexicalRankArgs): Promise<EmbeddingHit[]> {
    const queryText = args.queryText.trim();
    if (
      !queryText ||
      args.collectionIds.length === 0 ||
      args.limit <= 0 ||
      (args.entityIds && args.entityIds.length === 0)
    ) {
      return [];
    }
    await this.ensureReady();
    const result = await this.request<{ groups?: QdrantGroup[] }>(
      `/collections/${encodeURIComponent(this.collection)}/points/query/groups`,
      {
        method: "POST",
        body: JSON.stringify({
          query: { text: queryText },
          using: "chunk_text",
          filter: qdrantFilter(args),
          group_by: "entity_key",
          group_size: 1,
          limit: args.limit,
          with_payload: true,
        }),
      },
    );
    return embeddingHits(result);
  }
}
