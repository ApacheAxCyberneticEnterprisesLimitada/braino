import { type EmbeddingProviderLike, type QueryClient, upsertRetrievalEmbeddings } from "@doco/db";
import {
  type GraphEnrichmentMode,
  type RetrievalExtractor,
  type RetrievalLlmValidator,
  type RetrievalSourceDocument,
  ingestRetrievalSource,
} from "./retrieval-ingestion.js";

export const RETRIEVAL_SOURCE_KINDS = ["code", "node", "notion", "slack"] as const;
export type RetrievalSourceKind = (typeof RETRIEVAL_SOURCE_KINDS)[number];

interface RetrievalSourceRow {
  collection_id: string;
  source: RetrievalSourceKind;
  external_id: string;
  locator: string | null;
  title: string | null;
  content: string;
  access_scopes: string[];
}

export interface RetrievalSourceSyncResult {
  indexed: number;
  deleted: number;
  exhausted: boolean;
  bySource: Partial<Record<RetrievalSourceKind, number>>;
}

export interface RetrievalSourcePartition {
  /** Zero-based worker number. */
  index: number;
  /** Total number of workers sharing the source corpus. */
  count: number;
}

/**
 * Chunk and embed every source even when graph extraction is unavailable.
 * The retrieval graph then contains documents/chunks with exact provenance;
 * an injected fast or LLM extractor can add entities and relationships through
 * the same path without changing a connector.
 */
export const EMPTY_RETRIEVAL_EXTRACTOR: RetrievalExtractor = {
  async extract() {
    return { entities: [], relationships: [] };
  },
};

async function pruneMissingSources(
  c: QueryClient,
  collectionId: string | null,
  partition: RetrievalSourcePartition | null,
): Promise<number> {
  return (
    await c.query<{ id: string }>(
      `DELETE FROM retrieval_documents d
        WHERE d.source = ANY($1::text[])
          AND ($2::text IS NULL OR d.collection_id = $2)
          AND (
            $3::int IS NULL
            OR mod(mod(hashtext(d.collection_id || E'\\n' || d.source || E'\\n' || d.external_id), $3) + $3, $3) = $4
          )
          AND NOT EXISTS (
            SELECT 1 FROM retrieval_source_documents s
             WHERE s.collection_id = d.collection_id
               AND s.source = d.source
               AND s.external_id = d.external_id
          )
      RETURNING d.id`,
      [RETRIEVAL_SOURCE_KINDS, collectionId, partition?.count ?? null, partition?.index ?? null],
    )
  ).rows.length;
}

async function pendingSources(
  c: QueryClient,
  args: {
    collectionId: string | null;
    modelId: string;
    limit: number;
    partition: RetrievalSourcePartition | null;
  },
): Promise<RetrievalSourceRow[]> {
  return (
    await c.query<RetrievalSourceRow>(
      `SELECT s.collection_id, s.source, s.external_id, s.locator, s.title,
              s.content, s.access_scopes
         FROM retrieval_source_documents s
         LEFT JOIN retrieval_documents d
           ON d.collection_id = s.collection_id
          AND d.source = s.source
          AND d.external_id = s.external_id
        WHERE ($1::text IS NULL OR s.collection_id = $1)
          AND (
            $4::int IS NULL
            OR mod(mod(hashtext(s.collection_id || E'\\n' || s.source || E'\\n' || s.external_id), $4) + $4, $4) = $5
          )
          AND (
            d.id IS NULL
            OR d.content_hash IS DISTINCT FROM md5(s.content)
            OR NOT EXISTS (
              SELECT 1 FROM retrieval_chunks ch
               WHERE ch.document_id = d.id
            )
            OR EXISTS (
              SELECT 1 FROM retrieval_chunks ch
               WHERE ch.document_id = d.id
                 AND NOT EXISTS (
                   SELECT 1 FROM embeddings e
                    WHERE e.collection_id = ch.collection_id
                      AND e.source = 'retrieval_chunk'
                      AND e.entity_id = ch.id
                      AND e.model_id = $2
                 )
            )
          )
        ORDER BY s.source_updated_at DESC, s.collection_id, s.source, s.external_id
        LIMIT $3`,
      [
        args.collectionId,
        args.modelId,
        args.limit,
        args.partition?.count ?? null,
        args.partition?.index ?? null,
      ],
    )
  ).rows;
}

/**
 * Bring one bounded batch of durable source rows into the derived retrieval
 * index. Content hashes make reruns free; model changes deliberately rebuild
 * vectors for the new model. Source deletions prune their derived documents
 * and cascade through chunks, mentions, relations, and vectors.
 */
export async function syncRetrievalSourceBatch(
  c: QueryClient,
  args: {
    embeddingProvider: EmbeddingProviderLike;
    collectionId?: string;
    limit?: number;
    extractor?: RetrievalExtractor;
    llmValidator?: RetrievalLlmValidator;
    graphEnrichmentMode?: GraphEnrichmentMode;
    partition?: RetrievalSourcePartition;
  },
): Promise<RetrievalSourceSyncResult> {
  const collectionId = args.collectionId ?? null;
  const limit = Math.max(1, args.limit ?? 100);
  const partition = args.partition ?? null;
  if (
    partition &&
    (!Number.isInteger(partition.index) ||
      !Number.isInteger(partition.count) ||
      partition.count < 1 ||
      partition.index < 0 ||
      partition.index >= partition.count)
  ) {
    throw new Error("Retrieval source partition must have 0 <= index < count");
  }
  const deleted = await pruneMissingSources(c, collectionId, partition);
  const rows = await pendingSources(c, {
    collectionId,
    modelId: args.embeddingProvider.modelId,
    limit,
    partition,
  });
  const bySource: Partial<Record<RetrievalSourceKind, number>> = {};
  const embeddingTargets = {
    chunkIds: [] as string[],
    entityIds: [] as string[],
    relationIds: [] as string[],
  };
  for (const row of rows) {
    const document: RetrievalSourceDocument = {
      collectionId: row.collection_id,
      source: row.source,
      externalId: row.external_id,
      locator: row.locator,
      title: row.title,
      content: row.content,
      accessScopes: row.access_scopes,
    };
    const report = await ingestRetrievalSource(c, document, {
      extractor: args.extractor ?? EMPTY_RETRIEVAL_EXTRACTOR,
      ...(args.llmValidator ? { llmValidator: args.llmValidator } : {}),
      ...(args.graphEnrichmentMode ? { graphEnrichmentMode: args.graphEnrichmentMode } : {}),
    });
    embeddingTargets.chunkIds.push(...report.chunkIds);
    embeddingTargets.entityIds.push(...report.entityIds);
    embeddingTargets.relationIds.push(...report.relationIds);
    bySource[row.source] = (bySource[row.source] ?? 0) + 1;
  }
  if (rows.length > 0) {
    await upsertRetrievalEmbeddings(c, embeddingTargets, args.embeddingProvider);
  }
  return {
    indexed: rows.length,
    deleted,
    exhausted: rows.length < limit,
    bySource,
  };
}
