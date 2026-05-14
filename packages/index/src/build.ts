import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { parse as parseYaml } from "yaml";
import type { LoadedDoco } from "@doco/core";
import { openDb } from "./db.js";
import { insertEntity } from "./insert.js";
import {
  computeContentHash,
  type EmbeddingProviderLike,
  type EmbeddingsReport,
  upsertEmbeddings,
} from "./embeddings.js";
import { loadDocoFromPostgres } from "./loadFromPostgres.js";

export interface BuildReport {
  inserted: number;
  durationMs: number;
  embeddings?: EmbeddingsReport;
}

export interface IndexOptions {
  /**
   * Optional embedding provider (ADR-052). When provided, every entity is
   * embedded after the per-type insert pass and stored in the `embeddings`
   * table; content-hash gating skips entities whose text didn't change.
   * Omit to skip embeddings entirely (the previous behaviour).
   */
  embeddingProvider?: EmbeddingProviderLike;
}

/**
 * Names of tables truncated on every reindex. Everything not on this list
 * (`meta`, `embeddings`) survives across runs.
 *
 * The order matters only for readability — there are no foreign keys, and
 * each `DELETE` runs inside the indexDoco transaction.
 */
const MUTABLE_TABLES = [
  "edges",
  "scope_match",
  "fts",
  "doco_root",
  "principal",
  "intent",
  "idea",
  "rule",
  "decision",
  "action",
  "reasoning",
  "eval",
  "reference",
  "scope",
  "organization",
] as const;

/**
 * Clear every table that gets repopulated by `indexDoco`, leaving `meta`
 * (schema version) and `embeddings` (per-entity vectors) intact.
 *
 * Runs inside `indexDoco`'s own transaction so a crash during indexing
 * doesn't leave the cache half-truncated.
 */
function truncateMutableTables(db: Database): void {
  for (const t of MUTABLE_TABLES) {
    db.exec(`DELETE FROM ${t}`);
  }
}

/** Insert every entity from a freshly-loaded Doco. Caller manages the transaction. */
export async function indexDoco(
  db: Database,
  loaded: LoadedDoco,
  opts: IndexOptions = {},
): Promise<BuildReport> {
  const start = performance.now();
  let inserted = 0;
  const tx = db.transaction(() => {
    truncateMutableTables(db);
    insertEntity(db, loaded.doco as never, "");
    inserted++;
    for (const le of loaded.entities.values()) {
      insertEntity(db, le.entity, le.parsed.body);
      inserted++;
    }
  });
  tx();

  let embeddings: EmbeddingsReport | undefined;
  if (opts.embeddingProvider) {
    const docoId = (loaded.doco as { id: string }).id;
    const texts: { entity_id: string; doco_id: string; text: string; content_hash: string }[] = [];
    for (const le of loaded.entities.values()) {
      const summary = String((le.entity as { summary?: string }).summary ?? "");
      const body = le.parsed.body ?? "";
      const text = `${summary}\n\n${body}`.trim();
      if (!text) continue;
      texts.push({
        entity_id: (le.entity as { id: string }).id,
        doco_id: docoId,
        text,
        content_hash: computeContentHash(summary, body),
      });
    }
    try {
      embeddings = await upsertEmbeddings(db, texts, opts.embeddingProvider, {
        pruneStale: true,
      });
    } catch (err) {
      // Embeddings are best-effort: a transient provider failure
      // (rate limit, network blip) must not break the user-visible
      // capture/PATCH that triggered the reindex. Search will fall
      // back to the prior embeddings already in the cache.
      console.error("indexDoco: embedding pass failed (continuing without):", (err as Error).message);
    }
  }

  const durationMs = Math.round(performance.now() - start);
  return { inserted, durationMs, ...(embeddings ? { embeddings } : {}) };
}

/**
 * Rebuild the index from the current source files. Preserves the
 * `embeddings` table across runs — `upsertEmbeddings` skips entities
 * whose `(content_hash, model_id)` already matches, so steady-state
 * reindex of a Doco with no body changes is a no-op for the provider.
 *
 * On a schema-version bump, `openDb` → `migrate` drops every table
 * including `embeddings` and rebuilds, which is the right behaviour:
 * old vectors may not be compatible with the new shape.
 */
export async function reindex(
  docoRoot: string,
  opts: IndexOptions = {},
): Promise<BuildReport> {
  const loaded = await loadDocoFromPostgres(docoRoot, readDocoIdFromYaml(docoRoot));
  const db = await openDb(docoRoot);
  try {
    return await indexDoco(db, loaded, opts);
  } finally {
    db.close();
  }
}

/**
 * The on-disk `doco.yaml` is a thin pointer that carries only the
 * Doco's id; entity content lives in Postgres. Read the id here so
 * `loadDocoFromPostgres` knows which rows to pull.
 */
function readDocoIdFromYaml(docoRoot: string): string {
  const path = join(docoRoot, "doco.yaml");
  if (!existsSync(path)) {
    throw new Error(`No doco.yaml at ${docoRoot} to derive doco_id.`);
  }
  const fm = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
  const id = fm.id;
  if (typeof id !== "string" || !id.startsWith("doco_")) {
    throw new Error(`doco.yaml at ${docoRoot} has no usable 'id' field.`);
  }
  return id;
}
