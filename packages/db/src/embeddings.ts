// pgvector-backed embedding storage: one row per chunk of an entity's text,
// for graph entities and mirror rows alike (schema.sql, `embeddings`, one
// partition per Doco). Each chunk is gated by its own content hash, so an edit
// to one paragraph re-embeds one chunk, and ranking is one SQL statement: the
// nearest chunk of each entity to the query. Callers pass the client, so the
// same code runs inside a request, a cron tick, or a test's in-process
// Postgres.

export type EmbeddingSource = "node" | "notion" | "slack";

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
  doco_id: string;
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
  /** Delete the rows of the inputs' sources, in the inputs' Docos, for
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
  doco_id: string;
  entity_id: string;
  /** The entity's nearest chunk: what to show as the snippet. */
  chunk_text: string;
  /** Cosine similarity to the query, 1 for identical. */
  score: number;
}

/** The pgvector literal for a vector, zero-padded (or cut) to the column's
 *  dimensions. */
export function vectorLiteral(
  vector: ArrayLike<number>,
  dimensions = EMBEDDING_DIMENSIONS,
): string {
  const parts: string[] = new Array(dimensions);
  for (let i = 0; i < dimensions; i++) parts[i] = i < vector.length ? String(vector[i]) : "0";
  return `[${parts.join(",")}]`;
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
  const docoIds = [...new Set(entities.map((e) => e.doco_id))];
  const entityIds = entities.map((e) => e.entity_id);

  let pruned = 0;
  if (opts.pruneStale && docoIds.length > 0) {
    const sources = [...new Set(entities.map((e) => e.source))];
    pruned = (
      await c.query<{ entity_id: string }>(
        `DELETE FROM embeddings
          WHERE doco_id = ANY($1::text[]) AND source = ANY($2::text[])
            AND entity_id <> ALL($3::text[])
          RETURNING entity_id`,
        [docoIds, sources, entityIds],
      )
    ).rows.length;
  }
  if (entities.length === 0) return { computed: 0, skipped: 0, pruned, modelId };

  // Rows past each entity's chunk count go: a shorter text, or an emptied one.
  await c.query(
    `DELETE FROM embeddings e
      USING unnest($1::text[], $2::text[], $3::int[]) AS t(doco_id, entity_id, keep)
      WHERE e.doco_id = t.doco_id AND e.entity_id = t.entity_id AND e.chunk_index >= t.keep`,
    [entities.map((e) => e.doco_id), entityIds, entities.map((e) => e.chunks.length)],
  );

  const existing = (
    await c.query<{
      doco_id: string;
      entity_id: string;
      chunk_index: number;
      model_id: string;
      content_hash: string;
    }>(
      `SELECT doco_id, entity_id, chunk_index, model_id, content_hash
         FROM embeddings
        WHERE doco_id = ANY($1::text[]) AND entity_id = ANY($2::text[])`,
      [docoIds, entityIds],
    )
  ).rows;
  const have = new Map(existing.map((r) => [`${r.doco_id}\n${r.entity_id}\n${r.chunk_index}`, r]));

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
      const prev = have.get(`${entity.doco_id}\n${entity.entity_id}\n${index}`);
      if (prev && prev.model_id === modelId && prev.content_hash === hash) {
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
         (doco_id, source, entity_id, chunk_index, model_id, content_hash, chunk_text, embedding)
       SELECT r.doco_id, r.source, r.entity_id, r.chunk_index, $1, r.content_hash, r.chunk_text,
              r.embedding::vector
         FROM unnest($2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::text[], $8::text[])
           AS r(doco_id, source, entity_id, chunk_index, content_hash, chunk_text, embedding)
       ON CONFLICT (doco_id, entity_id, chunk_index) DO UPDATE SET
         source = EXCLUDED.source,
         model_id = EXCLUDED.model_id,
         content_hash = EXCLUDED.content_hash,
         chunk_text = EXCLUDED.chunk_text,
         embedding = EXCLUDED.embedding,
         updated_at = now()`,
      [
        modelId,
        batch.map((p) => p.entity.doco_id),
        batch.map((p) => p.entity.source),
        batch.map((p) => p.entity.entity_id),
        batch.map((p) => p.index),
        batch.map((p) => p.hash),
        batch.map((p) => p.text),
        vectors.map((v) => vectorLiteral(v)),
      ],
    );
    computed += batch.length;
  }
  return { computed, skipped, pruned, modelId };
}

/** Delete a source's rows in a Doco: all of them, or the named entities'.
 *  Returns how many went. */
export async function deleteEmbeddings(
  c: QueryClient,
  docoId: string,
  source: EmbeddingSource,
  entityIds?: string[],
): Promise<number> {
  if (entityIds && entityIds.length === 0) return 0;
  const rows = (
    await c.query<{ entity_id: string }>(
      `DELETE FROM embeddings
        WHERE doco_id = $1 AND source = $2
          AND ($3::text[] IS NULL OR entity_id = ANY($3::text[]))
        RETURNING entity_id`,
      [docoId, source, entityIds ?? null],
    )
  ).rows;
  return rows.length;
}

/**
 * The entities nearest the query: each entity's best chunk, best first,
 * among the Docos asked, for one source and the query's model (vectors from
 * another model are not comparable). It walks the Docos' indexes and rescores
 * on the whole vector (schema.sql, embeddings_nearest). `entityIds` narrows to
 * a candidate set, which is scored exactly.
 */
export async function rankEmbeddings(
  c: QueryClient,
  args: {
    docoIds: string[];
    source: EmbeddingSource;
    modelId: string;
    queryEmbedding: ArrayLike<number>;
    limit: number;
    entityIds?: string[] | null;
  },
): Promise<EmbeddingHit[]> {
  if (args.docoIds.length === 0 || args.limit <= 0) return [];
  if (args.entityIds && args.entityIds.length === 0) return [];
  const params = [
    vectorLiteral(args.queryEmbedding),
    args.docoIds,
    args.source,
    args.modelId,
    args.limit,
  ];
  const rows = (
    await c.query<{
      doco_id: string;
      entity_id: string;
      chunk_text: string;
      score: number | string;
    }>(
      args.entityIds
        ? `SELECT doco_id, entity_id, chunk_text, score FROM (
             SELECT DISTINCT ON (doco_id, entity_id)
                    doco_id, entity_id, chunk_text, 1 - (embedding <=> $1::vector) AS score
               FROM embeddings
              WHERE doco_id = ANY($2::text[]) AND source = $3 AND model_id = $4
                AND entity_id = ANY($6::text[])
              ORDER BY doco_id, entity_id, embedding <=> $1::vector
           ) best
           ORDER BY score DESC, doco_id, entity_id
           LIMIT $5`
        : "SELECT doco_id, entity_id, chunk_text, score FROM embeddings_nearest($1::vector, $2::text[], $3, $4, $5)",
      args.entityIds ? [...params, args.entityIds] : params,
    )
  ).rows;
  return rows.map((row) => ({ ...row, score: Number(row.score) }));
}
