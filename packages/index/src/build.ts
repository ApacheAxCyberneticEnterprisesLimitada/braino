// Reindexer. Rebuilds the derived-data tables in Postgres (`synapses`,
// `entity_fts`, `embeddings`) from the source-of-truth entity rows
// that already live in Postgres.

import {
  type EmbeddingProviderLike,
  type EmbeddingsReport,
  computeContentHash,
  rebuildDocoDerivedData,
  upsertEmbeddings,
} from "@doco/db";
import type { LoadedDoco } from "@doco/shared";
import { loadDocoFromPostgres } from "./loadDoco.js";
import { deriveSynapses } from "./synapses.js";

export interface BuildReport {
  inserted: number;
  durationMs: number;
  embeddings?: EmbeddingsReport;
}

export interface IndexOptions {
  /**
   * Optional embedding provider (ADR-052). When provided, every entity is
   * embedded after the indexing pass and stored in Postgres'
   * `embeddings` table; content-hash gating skips entities whose text
   * didn't change.
   */
  embeddingProvider?: EmbeddingProviderLike;
  /**
   * Internal Doco id. Required for every reindex; Postgres is the source
   * of truth and no filesystem metadata lookup is performed.
   */
  docoId?: string;
  /**
   * When set, restrict the derived-data rebuild to these entity ids
   * only — wipe and re-insert just their FTS rows + outgoing synapses,
   * leave the rest of the Doco's derived data alone. Embeddings are
   * recomputed only for the named entities (content-hash gated as
   * usual, so unchanged content is still skipped).
   *
   * Use for single-entity captures / patches where the caller knows
   * exactly which row changed. Omit for first build, bulk import, or
   * anywhere the safe-but-slow full rebuild is the right move.
   */
  changedEntityIds?: string[];
  /**
   * When true, skip the embedding pass even if `embeddingProvider`
   * is set. Used by the capture flow to split the fast structural
   * rebuild (FTS + synapses) from the slower OpenAI-bound embedding
   * pass — the structural pass runs inline so the response reflects
   * a fresh graph, while embeddings are offloaded to `waitUntil` and
   * caught up after the response is sent.
   */
  skipEmbeddings?: boolean;
  /**
   * When true, skip the FTS + synapses rebuild. Paired with the above:
   * the capture flow first runs `{ skipEmbeddings: true }` inline,
   * then `{ skipStructural: true }` in `waitUntil` so the embedding
   * pass catches up off the request path.
   */
  skipStructural?: boolean;
}

/**
 * Rebuild derived data (synapses, FTS, embeddings) for one Doco. Caller
 * supplies the pre-loaded LoadedDoco; this function does the PG writes.
 *
 * When `opts.changedEntityIds` is set, only those entities' derived
 * rows are touched — the rest of the Doco is left as-is. This is the
 * O(neighborhood) capture path. Without it, the full Doco is rebuilt
 * — the O(N+M) path used for cold starts and bulk operations.
 */
export async function indexDoco(loaded: LoadedDoco, opts: IndexOptions = {}): Promise<BuildReport> {
  const start = performance.now();

  const docoId = (loaded.doco as { id: string }).id;
  const incrementalIds =
    opts.changedEntityIds && opts.changedEntityIds.length > 0
      ? new Set(opts.changedEntityIds)
      : null;

  let inserted = 0;
  if (!opts.skipStructural) {
    const pgFts: { entity_id: string; entity_type: string; summary: string; body: string }[] = [];
    const pgSynapses: ReturnType<typeof deriveSynapses> = [];
    for (const le of loaded.entities.values()) {
      if (incrementalIds && !incrementalIds.has(le.entity.id)) continue;
      // Per-category interfaces carry `neuron_type`, `primitive_kind`, or
      // `kind`; the id prefix is the shared discriminator for derived rows.
      const entityType = le.entity.id.split("_").slice(0, -1).join("_") || "unknown";
      if (!entityType || entityType === "unknown") continue; // skip rows with no recoverable type
      inserted++;
      const e = le.entity as unknown as Record<string, unknown>;
      const summary = String(e.summary ?? "");
      const body = le.parsed.body ?? "";
      pgFts.push({
        entity_id: le.entity.id,
        entity_type: entityType,
        summary,
        body,
      });
      for (const synapse of deriveSynapses(le.entity)) {
        pgSynapses.push(synapse);
      }
    }
    await rebuildDocoDerivedData(
      docoId,
      pgFts,
      pgSynapses,
      incrementalIds ? { onlyEntityIds: [...incrementalIds] } : {},
    );
  }

  let embeddings: EmbeddingsReport | undefined;
  if (opts.embeddingProvider && !opts.skipEmbeddings) {
    const texts: { entity_id: string; doco_id: string; text: string; content_hash: string }[] = [];
    for (const le of loaded.entities.values()) {
      if (incrementalIds && !incrementalIds.has(le.entity.id)) continue;
      const entityRecord = le.entity as { summary?: string };
      const summary = String(entityRecord.summary ?? "");
      const body = le.parsed.body ?? "";
      const text = `${summary}\n\n${body}`.trim();
      if (!text) continue;
      texts.push({
        entity_id: (le.entity as { id: string }).id,
        doco_id: docoId,
        text,
        content_hash: await computeContentHash(summary, body),
      });
    }
    try {
      // Prune-stale wipes embeddings for entities NOT in `texts`. On
      // an incremental pass we're only passing one entity, so pruning
      // would nuke every other embedding in the Doco — disable.
      embeddings = await upsertEmbeddings(texts, opts.embeddingProvider, {
        pruneStale: !incrementalIds,
      });
    } catch (err) {
      // Best-effort: a transient provider failure (rate limit, network
      // blip) must not break the user-visible PATCH that triggered the
      // reindex.
      console.error(
        "indexDoco: embedding pass failed (continuing without):",
        (err as Error).message,
      );
    }
  }

  const durationMs = Math.round(performance.now() - start);
  return { inserted, durationMs, ...(embeddings ? { embeddings } : {}) };
}

/**
 * Pass `opts.changedEntityIds` for the incremental path (single-entity
 * captures): only those entities' FTS rows + outgoing synapses are touched
 * and the embedding pass is scoped to them. Omit for the safe-but-slow
 * full rebuild — first build, bulk import.
 */
export async function reindex(docoRoot: string, opts: IndexOptions = {}): Promise<BuildReport> {
  const docoId = opts.docoId;
  if (!docoId) {
    throw new Error("reindex requires opts.docoId.");
  }
  const loaded = await loadDocoFromPostgres(docoRoot, docoId);
  return indexDoco(loaded, opts);
}
