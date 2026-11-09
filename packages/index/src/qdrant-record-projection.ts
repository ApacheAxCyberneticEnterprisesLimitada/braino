import { createHash } from "node:crypto";
import type { QueryClient } from "@doco/db";
import type { VectorPointKey, VectorRecord, VectorStore } from "./qdrant-vector-store.js";

const MODEL_ID = "doco:record-search:v1";

interface ProjectionState {
  initialized: boolean;
  cursor_collection_id: string | null;
  cursor_node_id: string | null;
}

interface NodeRow {
  collection_id: string;
  id: string;
  prose: string;
  locator: string | null;
  title: string | null;
  name: string | null;
}

interface QueueRow extends NodeRow {
  operation: "upsert" | "delete";
}

export interface QdrantRecordProjectionReport {
  processed: number;
  upserted: number;
  deleted: number;
  phase: "backfill" | "queue";
  exhausted: boolean;
}

/** Reset only derived projection state after Qdrant recreates its collection. */
export async function resetNodeSearchProjection(client: QueryClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      `SELECT singleton
         FROM qdrant_record_projection_state
        WHERE singleton = true
        FOR UPDATE`,
    );
    await client.query("DELETE FROM qdrant_record_queue");
    await client.query(
      `UPDATE qdrant_record_projection_state
          SET initialized = false,
              cursor_collection_id = NULL,
              cursor_node_id = NULL,
              updated_at = now()
        WHERE singleton = true`,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function recordText(row: NodeRow): string {
  return [row.id, row.title, row.name, row.prose, row.locator]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
}

function vectorRecord(row: NodeRow): VectorRecord {
  const chunkText = recordText(row);
  return {
    collection_id: row.collection_id,
    source: "node",
    entity_id: row.id,
    chunk_index: 0,
    model_id: MODEL_ID,
    content_hash: createHash("sha256").update(chunkText).digest("hex"),
    chunk_text: chunkText,
    embedding: [1],
  };
}

function point(row: Pick<NodeRow, "collection_id" | "id">): VectorPointKey {
  return { collection_id: row.collection_id, entity_id: row.id, chunk_index: 0 };
}

/**
 * Advances one bounded batch of the rebuildable node-search projection.
 * External writes happen before the PostgreSQL acknowledgement, so a crash or
 * Qdrant error leaves the cursor/outbox untouched and safely retries the same
 * idempotent point operation.
 */
export async function syncNodeSearchProjection(
  client: QueryClient,
  store: VectorStore,
  options: { batchSize?: number } = {},
): Promise<QdrantRecordProjectionReport> {
  const batchSize = options.batchSize ?? 256;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("Qdrant record projection batch size must be a positive integer.");
  }

  await client.query("BEGIN");
  try {
    const state = (
      await client.query<ProjectionState>(
        `SELECT initialized, cursor_collection_id, cursor_node_id
           FROM qdrant_record_projection_state
          WHERE singleton = true
          FOR UPDATE`,
      )
    ).rows[0];
    if (!state) throw new Error("Qdrant record projection state is missing.");

    if (!state.initialized) {
      const rows = (
        await client.query<NodeRow>(
          `SELECT collection_id, id, prose, locator,
                  nullif(extra->>'title', '') AS title,
                  nullif(extra->>'name', '') AS name
             FROM nodes
            WHERE ($1::text IS NULL OR (collection_id, id) > ($1, $2))
            ORDER BY collection_id, id
            LIMIT $3`,
          [state.cursor_collection_id, state.cursor_node_id, batchSize],
        )
      ).rows;
      const records = rows.map(vectorRecord);
      if (records.length > 0) await store.upsert(records);

      const last = rows.at(-1);
      const exhausted = rows.length < batchSize;
      await client.query(
        `UPDATE qdrant_record_projection_state
            SET initialized = $1,
                cursor_collection_id = $2,
                cursor_node_id = $3,
                updated_at = now()
          WHERE singleton = true`,
        [exhausted, exhausted ? null : last?.collection_id, exhausted ? null : last?.id],
      );
      await client.query("COMMIT");
      return {
        processed: rows.length,
        upserted: rows.length,
        deleted: 0,
        phase: "backfill",
        exhausted,
      };
    }

    const rows = (
      await client.query<QueueRow>(
        `SELECT q.collection_id, q.node_id AS id, q.operation,
                n.prose, n.locator,
                nullif(n.extra->>'title', '') AS title,
                nullif(n.extra->>'name', '') AS name
           FROM qdrant_record_queue q
           LEFT JOIN nodes n
             ON n.collection_id = q.collection_id AND n.id = q.node_id
          ORDER BY q.queued_at, q.collection_id, q.node_id
          FOR UPDATE OF q SKIP LOCKED
          LIMIT $1`,
        [batchSize],
      )
    ).rows;
    const upserts = rows
      .filter((row) => row.operation === "upsert" && row.prose !== null)
      .map(vectorRecord);
    const deletes = rows
      .filter((row) => row.operation === "delete" || row.prose === null)
      .map(point);
    if (deletes.length > 0) await store.deletePoints(deletes);
    if (upserts.length > 0) await store.upsert(upserts);
    if (rows.length > 0) {
      await client.query(
        `DELETE FROM qdrant_record_queue q
          USING unnest($1::text[], $2::text[]) AS done(collection_id, node_id)
          WHERE q.collection_id = done.collection_id AND q.node_id = done.node_id`,
        [rows.map((row) => row.collection_id), rows.map((row) => row.id)],
      );
    }
    await client.query("COMMIT");
    return {
      processed: rows.length,
      upserted: upserts.length,
      deleted: deletes.length,
      phase: "queue",
      exhausted: rows.length < batchSize,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
