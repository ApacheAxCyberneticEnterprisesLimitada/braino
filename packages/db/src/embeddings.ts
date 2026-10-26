// Embedding metadata and durable Qdrant-sync storage: one row per chunk of an entity's text,
// for graph entities and mirror rows alike (schema.sql, `embeddings`, one
// partition per collection). Each chunk is gated by its own content hash, so an edit
// to one paragraph re-embeds one chunk, and ranking is one SQL statement: the
// nearest chunk of each entity to the query. Callers pass the client, so the
// same code runs inside a request, a cron tick, or a test's in-process
// Postgres. Qdrant is the production similarity engine.

export type EmbeddingSource =
  | "node"
  | "notion"
  | "slack"
  | "retrieval_chunk"
  | "retrieval_entity"
  | "retrieval_relation";

/** The column's dimensions; shorter vectors are zero-padded on the way in,
 *  which leaves cosine similarity unchanged. */
export const EMBEDDING_DIMENSIONS = 1536;
/** Chunks per provider call: well under OpenAI's 2,048 inputs, and short
 *  enough that a call finishes in a second or two. */
export const EMBEDDING_BATCH = 100;

export interface QueryClient {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

// `inputType` mirrors @doco/index's EmbeddingInputType ("query" | "document").
// Inlined rather than imported because @doco/index depends on @doco/db, not
// the other way round; the two definitions must stay in sync.
export interface EmbeddingProviderLike {
  modelId: string;
  dimensions: number;
  embed(texts: string[], inputType?: "query" | "document"): Promise<Float32Array[]>;
}

export interface EmbeddingInput {
  source: EmbeddingSource;
  entity_id: string;
  collection_id: string;
  /** The texts to embed, in order. Blank ones are dropped; an entity left
   *  with none loses its rows. */
  chunks: string[];
}

export interface EmbeddingsReport {
  computed: number;
  skipped: number;
  pruned: number;
  modelId: string;
}

export interface UpsertEmbeddingsOptions {
  /** Delete the rows of the inputs' sources, in the inputs' Collections, for
   *  entities not in the input set: a full reindex's stale sweep. */
  pruneStale?: boolean;
}

/** The query side of a semantic search: the query's vector and the model
 *  that produced it, so only comparable rows are ranked. */
export interface SemanticQuery {
  queryEmbedding: ArrayLike<number>;
  modelId: string;
}

export interface EmbeddingHit {
  collection_id: string;
  entity_id: string;
  /** The entity's nearest chunk: what to show as the snippet. */
  chunk_text: string;
  /** Cosine similarity to the query, 1 for identical. */
  score: number;
}

/** A PostgreSQL real-array literal, zero-padded (or cut) to Qdrant's
 * dimensions. */
export function embeddingLiteral(
  vector: ArrayLike<number>,
  dimensions = EMBEDDING_DIMENSIONS,
): string {
  const parts: string[] = new Array(dimensions);
  for (let i = 0; i < dimensions; i++) parts[i] = i < vector.length ? String(vector[i]) : "0";
  return `{${parts.join(",")}}`;
}

/**
 * Embed the inputs' chunks that the table lacks for this model and write
 * them, one provider call per batch. Unchanged chunks (same model, same
 * hash) are skipped; chunks past an entity's new count are dropped.
 */
export async function upsertEmbeddings(
  c: QueryClient,
  inputs: EmbeddingInput[],
  provider: EmbeddingProviderLike,
  opts: UpsertEmbeddingsOptions = {},
): Promise<EmbeddingsReport> {
  const modelId = provider.modelId;
  const entities = inputs.map((input) => ({
    ...input,
    chunks: input.chunks.map((chunk) => chunk.trim()).filter(Boolean),
  }));
  const collectionIds = [...new Set(entities.map((e) => e.collection_id))];
  const entityIds = entities.map((e) => e.entity_id);

  let pruned = 0;
  if (opts.pruneStale && collectionIds.length > 0) {
    const sources = [...new Set(entities.map((e) => e.source))];
    pruned = (
      await c.query<{ entity_id: string }>(
        `DELETE FROM embeddings
          WHERE collection_id = ANY($1::text[]) AND source = ANY($2::text[])
            AND entity_id <> ALL($3::text[])
          RETURNING entity_id`,
        [collectionIds, sources, entityIds],
      )
    ).rows.length;
  }
  if (entities.length === 0) return { computed: 0, skipped: 0, pruned, modelId };

  // Rows past each entity's chunk count go: a shorter text, or an emptied one.
  await c.query(
    `DELETE FROM embeddings e
      USING unnest($1::text[], $2::text[], $3::int[]) AS t(collection_id, entity_id, keep)
      WHERE e.collection_id = t.collection_id AND e.entity_id = t.entity_id AND e.chunk_index >= t.keep`,
    [entities.map((e) => e.collection_id), entityIds, entities.map((e) => e.chunks.length)],
  );

  const existing = (
    await c.query<{
      collection_id: string;
      entity_id: string;
      chunk_index: number;
      model_id: string;
      content_hash: string;
      has_embedding: boolean;
    }>(
      `SELECT collection_id, entity_id, chunk_index, model_id, content_hash,
              embedding IS NOT NULL AS has_embedding
         FROM embeddings
        WHERE collection_id = ANY($1::text[]) AND entity_id = ANY($2::text[])`,
      [collectionIds, entityIds],
    )
  ).rows;
  const have = new Map(
    existing.map((r) => [`${r.collection_id}\n${r.entity_id}\n${r.chunk_index}`, r]),
  );

  // node:crypto is imported lazily so the @doco/db barrel stays out of
  // browser bundles.
  const { createHash } = await import(/* @vite-ignore */ "node:crypto");
  const pending: {
    entity: (typeof entities)[number];
    index: number;
    text: string;
    hash: string;
  }[] = [];
  let skipped = 0;
  for (const entity of entities) {
    for (let index = 0; index < entity.chunks.length; index++) {
      const text = entity.chunks[index];
      const hash = createHash("sha1").update(text).digest("hex");
      const prev = have.get(`${entity.collection_id}\n${entity.entity_id}\n${index}`);
      if (prev?.has_embedding && prev.model_id === modelId && prev.content_hash === hash) {
        skipped++;
        continue;
      }
      pending.push({ entity, index, text, hash });
    }
  }

  let computed = 0;
  for (let at = 0; at < pending.length; at += EMBEDDING_BATCH) {
    const batch = pending.slice(at, at + EMBEDDING_BATCH);
    // Indexing the corpus: these are documents, not queries. Asymmetric
    // providers (Voyage/Cohere) use the hint; symmetric ones ignore it.
    const vectors = await provider.embed(
      batch.map((p) => p.text),
      "document",
    );
    if (vectors.length !== batch.length) {
      throw new Error(
        `Embedding provider returned ${vectors.length} vectors for ${batch.length} inputs (provider=${modelId}).`,
      );
    }
    await c.query(
      `INSERT INTO embeddings
         (collection_id, source, entity_id, chunk_index, model_id, content_hash, chunk_text, embedding)
       SELECT r.collection_id, r.source, r.entity_id, r.chunk_index, $1, r.content_hash, r.chunk_text,
              r.embedding::real[]
         FROM unnest($2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::text[], $8::text[])
           AS r(collection_id, source, entity_id, chunk_index, content_hash, chunk_text, embedding)
       ON CONFLICT (collection_id, entity_id, chunk_index) DO UPDATE SET
         source = EXCLUDED.source,
         model_id = EXCLUDED.model_id,
         content_hash = EXCLUDED.content_hash,
         chunk_text = EXCLUDED.chunk_text,
         embedding = EXCLUDED.embedding,
         updated_at = now()`,
      [
        modelId,
        batch.map((p) => p.entity.collection_id),
        batch.map((p) => p.entity.source),
        batch.map((p) => p.entity.entity_id),
        batch.map((p) => p.index),
        batch.map((p) => p.hash),
        batch.map((p) => p.text),
        vectors.map((v) => embeddingLiteral(v)),
      ],
    );
    computed += batch.length;
  }
  return { computed, skipped, pruned, modelId };
}

/** Delete a source's rows in a collection: all of them, or the named entities'.
 *  Returns how many went. */
export async function deleteEmbeddings(
  c: QueryClient,
  collectionId: string,
  source: EmbeddingSource,
  entityIds?: string[],
): Promise<number> {
  if (entityIds && entityIds.length === 0) return 0;
  const rows = (
    await c.query<{ entity_id: string }>(
      `DELETE FROM embeddings
        WHERE collection_id = $1 AND source = $2
          AND ($3::text[] IS NULL OR entity_id = ANY($3::text[]))
        RETURNING entity_id`,
      [collectionId, source, entityIds ?? null],
    )
  ).rows;
  return rows.length;
}

/**
 * The entities nearest the query: each entity's best chunk, best first,
 * among the collections asked, for one source and the query's model (vectors from
 * another model are not comparable). Production callers use Qdrant. This
 * exact array scan remains for deterministic local evaluation of small
 * fixtures; it has no database vector extension or index. `entityIds` narrows
 * to a candidate set.
 */
export async function rankEmbeddings(
  c: QueryClient,
  args: {
    collectionIds: string[];
    source: EmbeddingSource;
    modelId: string;
    queryEmbedding: ArrayLike<number>;
    limit: number;
    entityIds?: string[] | null;
  },
): Promise<EmbeddingHit[]> {
  if (args.collectionIds.length === 0 || args.limit <= 0) return [];
  if (args.entityIds && args.entityIds.length === 0) return [];
  const params = [
    embeddingLiteral(args.queryEmbedding),
    args.collectionIds,
    args.source,
    args.modelId,
    args.limit,
    args.entityIds ?? null,
  ];
  const rows = (
    await c.query<{
      collection_id: string;
      entity_id: string;
      chunk_text: string;
      score: number | string;
    }>(
      `WITH scored AS (
         SELECT e.collection_id, e.entity_id, e.chunk_text,
                similarity.score
           FROM embeddings e
           CROSS JOIN LATERAL (
             SELECT CASE WHEN sums.left_norm = 0 OR sums.right_norm = 0 THEN 0
                         ELSE sums.dot / sqrt(sums.left_norm * sums.right_norm) END AS score
               FROM (
                 SELECT sum(value * query_value)::double precision AS dot,
                        sum(value * value)::double precision AS left_norm,
                        sum(query_value * query_value)::double precision AS right_norm
                   FROM unnest(e.embedding, $1::real[]) AS pair(value, query_value)
               ) sums
           ) similarity
          WHERE e.collection_id = ANY($2::text[]) AND e.source = $3 AND e.model_id = $4
            AND e.embedding IS NOT NULL
            AND ($6::text[] IS NULL OR e.entity_id = ANY($6::text[]))
       ), best AS (
         SELECT DISTINCT ON (collection_id, entity_id)
                collection_id, entity_id, chunk_text, score
           FROM scored
          ORDER BY collection_id, entity_id, score DESC, chunk_text
       )
       SELECT collection_id, entity_id, chunk_text, score
         FROM best
        ORDER BY score DESC, collection_id, entity_id
        LIMIT $5`,
      params,
    )
  ).rows;
  return rows.map((row) => ({ ...row, score: Number(row.score) }));
}
