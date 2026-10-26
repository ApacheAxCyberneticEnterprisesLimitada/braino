import type { EmbeddingSource, QueryClient } from "@doco/db";
import type { VectorRecord, VectorStore } from "./qdrant-vector-store.js";

interface EmbeddingRow {
  collection_id: string;
  source: EmbeddingSource;
  entity_id: string;
  chunk_index: number;
  model_id: string;
  content_hash: string;
  chunk_text: string;
  embedding: number[];
}

export interface QdrantBackfillOptions {
  batchSize?: number;
  collectionIds?: string[];
  onBatch?: (report: QdrantBackfillReport) => void;
}

export interface QdrantBackfillReport {
  rows: number;
  batches: number;
}

export function embeddingValues(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "number" || !Number.isFinite(item))
  ) {
    throw new Error("Embedding must be an array of finite numbers.");
  }
  return value;
}

/** Copy the authoritative PostgreSQL embedding rows into the rebuildable
 * Qdrant index. Keyset pagination keeps memory bounded for large collections. */
export async function backfillEmbeddingsToVectorStore(
  c: QueryClient,
  store: VectorStore,
  options: QdrantBackfillOptions = {},
): Promise<QdrantBackfillReport> {
  const batchSize = options.batchSize ?? 500;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("Qdrant backfill batch size must be a positive integer.");
  }
  if (options.collectionIds?.length === 0) return { rows: 0, batches: 0 };

  const report = { rows: 0, batches: 0 };
  let cursor: Pick<EmbeddingRow, "collection_id" | "entity_id" | "chunk_index"> | null = null;
  while (true) {
    const rows: EmbeddingRow[] = (
      await c.query<EmbeddingRow>(
        `SELECT collection_id, source, entity_id, chunk_index, model_id,
                content_hash, chunk_text, embedding
           FROM embeddings
          WHERE ($1::text[] IS NULL OR collection_id = ANY($1::text[]))
            AND embedding IS NOT NULL
            AND ($2::text IS NULL OR
                 (collection_id, entity_id, chunk_index) > ($2, $3, $4))
          ORDER BY collection_id, entity_id, chunk_index
          LIMIT $5`,
        [
          options.collectionIds ?? null,
          cursor?.collection_id ?? null,
          cursor?.entity_id ?? null,
          cursor?.chunk_index ?? null,
          batchSize,
        ],
      )
    ).rows;
    if (rows.length === 0) return report;

    const records: VectorRecord[] = rows.map((row: EmbeddingRow) => ({
      ...row,
      embedding: embeddingValues(row.embedding),
    }));
    await store.upsert(records);
    report.rows += rows.length;
    report.batches += 1;
    options.onBatch?.({ ...report });
    const last = rows.at(-1);
    if (!last) throw new Error("Qdrant backfill lost its non-empty batch.");
    cursor = {
      collection_id: last.collection_id,
      entity_id: last.entity_id,
      chunk_index: last.chunk_index,
    };
  }
}
