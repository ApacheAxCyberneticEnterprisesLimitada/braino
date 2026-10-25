import type { EmbeddingSource, QueryClient } from "@doco/db";
import { parsePgVector } from "./qdrant-backfill.js";
import type { VectorPointKey, VectorRecord, VectorStore } from "./qdrant-vector-store.js";

interface QueueRow {
  collection_id: string;
  entity_id: string;
  chunk_index: number;
  operation: "upsert" | "delete" | "delete_collection";
  source: EmbeddingSource | null;
  model_id: string | null;
  content_hash: string | null;
  chunk_text: string | null;
  embedding: string | null;
}

export interface QdrantSyncReport {
  processed: number;
  upserted: number;
  deleted: number;
  collectionsDeleted: number;
  exhausted: boolean;
}

/** Drain one locked outbox batch into a derived vector index. The queue row
 * stays until the external writes succeed; a crash therefore retries an
 * idempotent Qdrant operation instead of losing an embedding change. */
export async function syncQueuedEmbeddings(
  c: QueryClient,
  store: VectorStore,
  options: { batchSize?: number } = {},
): Promise<QdrantSyncReport> {
  const batchSize = options.batchSize ?? 256;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("Qdrant sync batch size must be a positive integer.");
  }

  await c.query("BEGIN");
  try {
    const rows = (
      await c.query<QueueRow>(
        `SELECT q.collection_id, q.entity_id, q.chunk_index, q.operation,
                e.source, e.model_id, e.content_hash, e.chunk_text,
                e.embedding::text AS embedding
           FROM embedding_vector_queue q
           LEFT JOIN embeddings e
             ON e.collection_id = q.collection_id
            AND e.entity_id = q.entity_id
            AND e.chunk_index = q.chunk_index
          ORDER BY q.queued_at, q.collection_id, q.entity_id, q.chunk_index
          FOR UPDATE OF q SKIP LOCKED
          LIMIT $1`,
        [batchSize],
      )
    ).rows;

    const collectionIds = rows
      .filter((row) => row.operation === "delete_collection")
      .map((row) => row.collection_id);
    const upserts: VectorRecord[] = [];
    const deletes: VectorPointKey[] = [];
    for (const row of rows) {
      if (row.operation === "delete_collection") continue;
      if (
        row.operation === "upsert" &&
        row.source &&
        row.model_id &&
        row.content_hash &&
        row.chunk_text !== null &&
        row.embedding
      ) {
        upserts.push({
          collection_id: row.collection_id,
          source: row.source,
          entity_id: row.entity_id,
          chunk_index: row.chunk_index,
          model_id: row.model_id,
          content_hash: row.content_hash,
          chunk_text: row.chunk_text,
          embedding: parsePgVector(row.embedding),
        });
      } else {
        // The authoritative row may have disappeared after an upsert was
        // queued; deleting the exact point reflects its current state.
        deletes.push({
          collection_id: row.collection_id,
          entity_id: row.entity_id,
          chunk_index: row.chunk_index,
        });
      }
    }

    if (collectionIds.length > 0) await store.delete({ collectionIds });
    if (deletes.length > 0) await store.deletePoints(deletes);
    if (upserts.length > 0) await store.upsert(upserts);
    if (rows.length > 0) {
      await c.query(
        `DELETE FROM embedding_vector_queue q
          USING unnest($1::text[], $2::text[], $3::int[])
            AS done(collection_id, entity_id, chunk_index)
          WHERE q.collection_id = done.collection_id
            AND q.entity_id = done.entity_id
            AND q.chunk_index = done.chunk_index`,
        [
          rows.map((row) => row.collection_id),
          rows.map((row) => row.entity_id),
          rows.map((row) => row.chunk_index),
        ],
      );
    }
    await c.query("COMMIT");
    return {
      processed: rows.length,
      upserted: upserts.length,
      deleted: deletes.length,
      collectionsDeleted: collectionIds.length,
      exhausted: rows.length < batchSize,
    };
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  }
}
