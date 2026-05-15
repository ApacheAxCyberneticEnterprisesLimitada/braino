// Postgres-backed embedding storage. Replaces the SQLite `embeddings`
// table that lived in @doco/index. Same algorithm (content-hash-gated
// upsert, model-id stamping), different store.
//
// Storage wire format is `bytea` (Float32Array bytes, little-endian) —
// same on-disk shape as the SQLite BLOB it replaces, so a future swap
// to pgvector's `vector(N)` type is a column-type migration with no
// reformat.

import { createHash } from "node:crypto";
import { withClient, withTransaction } from "./client.js";

export interface EmbeddingProviderLike {
  modelId: string;
  dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** SHA-1 of (summary + "\n\n" + body). Stable across runs. */
export function computeContentHash(summary: string, body: string): string {
  return createHash("sha1").update(`${summary}\n\n${body}`).digest("hex");
}

/** Cosine similarity between two equally-sized vectors. Returns 0 on a zero vector. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Float32Array → Buffer (no copy). Little-endian. */
export function embeddingToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/** Buffer → Float32Array. Copies into an aligned buffer when needed. */
export function bufferToEmbedding(buf: Buffer): Float32Array {
  if (buf.byteOffset % 4 === 0) {
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }
  const copy = new ArrayBuffer(buf.byteLength);
  new Uint8Array(copy).set(buf);
  return new Float32Array(copy);
}

export interface EmbeddingsReport {
  computed: number;
  skipped: number;
  pruned: number;
  modelId: string;
}

export interface UpsertEmbeddingsOptions {
  /**
   * When true, delete embedding rows for entity_ids not present in
   * the input set after the upsert. Scoped to the Doco of the
   * passed entries (we won't ever delete across docos).
   */
  pruneStale?: boolean;
}

export interface EmbeddingInput {
  entity_id: string;
  doco_id: string;
  text: string;
  content_hash: string;
}

/**
 * Walk every entity, embed any whose `(model_id, content_hash)` doesn't
 * match the current row, and upsert. Runs the whole pass inside one
 * transaction so a crash mid-batch doesn't leave half-written rows.
 *
 * Empty / whitespace-only texts are skipped — there's nothing to embed.
 */
export async function upsertEmbeddings(
  inputs: EmbeddingInput[],
  provider: EmbeddingProviderLike,
  opts: UpsertEmbeddingsOptions = {},
): Promise<EmbeddingsReport> {
  const modelId = provider.modelId;
  const candidates = inputs.filter((t) => t.text.trim().length > 0);

  // Group by doco_id for the prune step (single-Doco runs are the
  // common case, but we don't assume).
  const docoIds = Array.from(new Set(candidates.map((c) => c.doco_id)));

  let pruned = 0;
  if (opts.pruneStale) {
    pruned = await pruneStaleEmbeddings(
      docoIds,
      new Set(candidates.map((c) => c.entity_id)),
    );
  }

  if (candidates.length === 0) {
    return { computed: 0, skipped: 0, pruned, modelId };
  }

  const ids = candidates.map((c) => c.entity_id);
  const existing = await withClient(async (c) => {
    const r = await c.query<{ entity_id: string; model_id: string; content_hash: string }>(
      `SELECT entity_id, model_id, content_hash
         FROM embeddings
        WHERE entity_id = ANY($1::text[])`,
      [ids],
    );
    return r.rows;
  });
  const byId = new Map(existing.map((r) => [r.entity_id, r]));

  const toEmbed: EmbeddingInput[] = [];
  let skipped = 0;
  for (const c of candidates) {
    const prev = byId.get(c.entity_id);
    if (prev && prev.model_id === modelId && prev.content_hash === c.content_hash) {
      skipped++;
      continue;
    }
    toEmbed.push(c);
  }
  if (toEmbed.length === 0) {
    return { computed: 0, skipped, pruned, modelId };
  }

  const vectors = await provider.embed(toEmbed.map((c) => c.text));
  if (vectors.length !== toEmbed.length) {
    throw new Error(
      `Embedding provider returned ${vectors.length} vectors for ${toEmbed.length} inputs (provider=${modelId}).`,
    );
  }

  await withTransaction(async (c) => {
    for (let i = 0; i < toEmbed.length; i++) {
      const t = toEmbed[i];
      await c.query(
        `INSERT INTO embeddings (entity_id, doco_id, model_id, content_hash, embedding, updated_at)
              VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (entity_id) DO UPDATE SET
              doco_id      = EXCLUDED.doco_id,
              model_id     = EXCLUDED.model_id,
              content_hash = EXCLUDED.content_hash,
              embedding    = EXCLUDED.embedding,
              updated_at   = now()`,
        [t.entity_id, t.doco_id, modelId, t.content_hash, embeddingToBuffer(vectors[i])],
      );
    }
  });

  return { computed: toEmbed.length, skipped, pruned, modelId };
}

/**
 * Delete embedding rows in the named docos whose entity_id is NOT in `keep`.
 * Operates per-Doco so a reindex of Doco X never wipes Doco Y's vectors.
 */
async function pruneStaleEmbeddings(
  docoIds: string[],
  keep: Set<string>,
): Promise<number> {
  if (docoIds.length === 0) return 0;
  return withClient(async (c) => {
    if (keep.size === 0) {
      const r = await c.query(
        `DELETE FROM embeddings WHERE doco_id = ANY($1::text[])`,
        [docoIds],
      );
      return r.rowCount ?? 0;
    }
    const r = await c.query(
      `DELETE FROM embeddings
        WHERE doco_id = ANY($1::text[])
          AND entity_id <> ALL($2::text[])`,
      [docoIds, Array.from(keep)],
    );
    return r.rowCount ?? 0;
  });
}

/**
 * Bulk-fetch embeddings by entity id. Ids without a row are absent.
 */
export async function getEmbeddings(
  entityIds: string[],
): Promise<Map<string, Float32Array>> {
  if (entityIds.length === 0) return new Map();
  return withClient(async (c) => {
    const r = await c.query<{ entity_id: string; embedding: Buffer }>(
      `SELECT entity_id, embedding FROM embeddings WHERE entity_id = ANY($1::text[])`,
      [entityIds],
    );
    return new Map(r.rows.map((row) => [row.entity_id, bufferToEmbedding(row.embedding)]));
  });
}

/**
 * Every embedding for one Doco. Used by the semantic search endpoints
 * (ADR-052): candidate set is the full Doco, ranked by cosine in
 * application code.
 */
export async function getAllEmbeddingsForDoco(
  docoId: string,
): Promise<{ entity_id: string; embedding: Float32Array }[]> {
  return withClient(async (c) => {
    const r = await c.query<{ entity_id: string; embedding: Buffer }>(
      `SELECT entity_id, embedding FROM embeddings WHERE doco_id = $1`,
      [docoId],
    );
    return r.rows.map((row) => ({
      entity_id: row.entity_id,
      embedding: bufferToEmbedding(row.embedding),
    }));
  });
}
