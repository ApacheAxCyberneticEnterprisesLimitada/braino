// Storage layer for entity embeddings (ADR-052). Pure SQLite operations
// plus a couple of helpers — no provider knowledge, no OpenAI calls.
// The reindex caller supplies a structurally-typed provider; this module
// just persists what it returns.
import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";

/**
 * Structural shape of an embedding provider. Matches
 * `@doco/discovery`'s `EmbeddingProvider` but typed inline so this
 * package doesn't take a circular dependency on discovery.
 */
export interface EmbeddingProviderLike {
  modelId: string;
  dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface EmbeddingRow {
  entity_id: string;
  model_id: string;
  content_hash: string;
  embedding: Float32Array;
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

/** Float32Array → Buffer (no copy). Little-endian, matches Node's native order on x86/ARM. */
export function embeddingToBlob(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/** Buffer → Float32Array. Copies into an aligned buffer if the input isn't 4-byte aligned. */
export function blobToEmbedding(buf: Buffer): Float32Array {
  if (buf.byteOffset % 4 === 0) {
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }
  const copy = new ArrayBuffer(buf.byteLength);
  new Uint8Array(copy).set(buf);
  return new Float32Array(copy);
}

export interface EmbeddingsReport {
  /** Rows freshly embedded this run (new or content-hash mismatch). */
  computed: number;
  /** Rows whose hash + model matched — embedding was reused. */
  skipped: number;
  /**
   * Rows deleted because their entity_id was no longer in the input set
   * (entity removed from disk between reindex runs). Only populated when
   * `pruneStale: true` is passed.
   */
  pruned: number;
  /** Provider model id. Stamped on every upserted row. */
  modelId: string;
}

export interface UpsertEmbeddingsOptions {
  /**
   * When true, delete embedding rows for entity_ids not present in
   * `texts` after the upsert. Use this from reindex paths where the
   * input set is authoritative — leaving stale rows around grows the
   * table without any query ever returning them.
   *
   * Off by default so partial / incremental callers (e.g. updating one
   * entity) don't accidentally wipe the rest of the table.
   */
  pruneStale?: boolean;
}

/**
 * Walk every entity, embed any whose `(model_id, content_hash)` doesn't
 * match the current row, and upsert. Caller wraps in its own transaction
 * if it wants atomicity with the rest of indexing.
 *
 * `texts` is `[entity_id, summary + body]` pairs. Empty or whitespace-only
 * texts are skipped (we won't embed nothing).
 */
export async function upsertEmbeddings(
  db: Database,
  texts: { entity_id: string; doco_id: string; text: string; content_hash: string }[],
  provider: EmbeddingProviderLike,
  opts: UpsertEmbeddingsOptions = {},
): Promise<EmbeddingsReport> {
  const modelId = provider.modelId;
  // Filter out entries with no content — there's nothing to embed.
  const candidates = texts.filter((t) => t.text.trim().length > 0);

  // Pruning runs even when the candidate set is empty (a Doco that
  // shrank to zero embeddable entities should empty the table).
  let pruned = 0;
  if (opts.pruneStale) {
    pruned = pruneStaleEmbeddings(db, candidates.map((c) => c.entity_id));
  }

  if (candidates.length === 0) {
    return { computed: 0, skipped: 0, pruned, modelId };
  }

  // Fetch existing rows for the candidate ids.
  const ids = candidates.map((c) => c.entity_id);
  const placeholders = ids.map(() => "?").join(",");
  const existing = db
    .prepare(
      `SELECT entity_id, model_id, content_hash FROM embeddings WHERE entity_id IN (${placeholders})`,
    )
    .all(...ids) as { entity_id: string; model_id: string; content_hash: string }[];
  const byId = new Map(existing.map((r) => [r.entity_id, r]));

  const toEmbed: { entity_id: string; doco_id: string; text: string; content_hash: string }[] = [];
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

  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO embeddings (entity_id, doco_id, model_id, content_hash, embedding, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity_id) DO UPDATE SET
       doco_id = excluded.doco_id,
       model_id = excluded.model_id,
       content_hash = excluded.content_hash,
       embedding = excluded.embedding,
       updated_at = excluded.updated_at`,
  );
  const tx = db.transaction(() => {
    for (let i = 0; i < toEmbed.length; i++) {
      const c = toEmbed[i];
      upsert.run(
        c.entity_id,
        c.doco_id,
        modelId,
        c.content_hash,
        embeddingToBlob(vectors[i]),
        now,
      );
    }
  });
  tx();

  return { computed: toEmbed.length, skipped, pruned, modelId };
}

/**
 * Delete rows whose entity_id isn't in `keep`. Returns the number deleted.
 * SQLite's `IN (...)` is fine up to a few thousand ids; beyond that we'd
 * batch — but reindex passes typically stay well under that.
 */
function pruneStaleEmbeddings(db: Database, keep: string[]): number {
  if (keep.length === 0) {
    const info = db.prepare("DELETE FROM embeddings").run();
    return info.changes ?? 0;
  }
  const placeholders = keep.map(() => "?").join(",");
  const info = db
    .prepare(`DELETE FROM embeddings WHERE entity_id NOT IN (${placeholders})`)
    .run(...keep);
  return info.changes ?? 0;
}

/**
 * Bulk-fetch embeddings for a set of entity ids. Returns a Map keyed by
 * entity_id; ids without an embedding row are absent from the map.
 */
export function getEmbeddings(
  db: Database,
  entityIds: string[],
): Map<string, Float32Array> {
  if (entityIds.length === 0) return new Map();
  const placeholders = entityIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT entity_id, embedding FROM embeddings WHERE entity_id IN (${placeholders})`)
    .all(...entityIds) as { entity_id: string; embedding: Buffer }[];
  return new Map(rows.map((r) => [r.entity_id, blobToEmbedding(r.embedding)]));
}

/**
 * Stream every embedding for one node type. Used by find-rules Strategy 4
 * (semantic over rules) where we cosine the query against every rule.
 */
export function getEmbeddingsByNodeType(
  db: Database,
  nodeType: string,
): { entity_id: string; embedding: Float32Array }[] {
  // The embeddings table doesn't carry node_type, so join through the
  // per-type table by id.
  const rows = db
    .prepare(
      `SELECT e.entity_id AS entity_id, e.embedding AS embedding
       FROM embeddings e
       INNER JOIN ${nodeType} t ON t.id = e.entity_id`,
    )
    .all() as { entity_id: string; embedding: Buffer }[];
  return rows.map((r) => ({
    entity_id: r.entity_id,
    embedding: blobToEmbedding(r.embedding),
  }));
}

/**
 * Stream every embedding across the whole Doco. Used by the vector-only
 * `/search.json` and `/search` surfaces (ADR-052; supersedes ADR-030):
 * candidate set is the full Doco, ranked by cosine.
 *
 * At Tier B scale (≤100k entities, ADR-049) a full scan is fine — cosine
 * over a 1536-dim vector is a few microseconds. For larger Docos we'd
 * pre-cluster or add an ANN index, but that's not v1.
 */
export function getAllEmbeddings(
  db: Database,
): { entity_id: string; embedding: Float32Array }[] {
  const rows = db
    .prepare(`SELECT entity_id, embedding FROM embeddings`)
    .all() as { entity_id: string; embedding: Buffer }[];
  return rows.map((r) => ({
    entity_id: r.entity_id,
    embedding: blobToEmbedding(r.embedding),
  }));
}
