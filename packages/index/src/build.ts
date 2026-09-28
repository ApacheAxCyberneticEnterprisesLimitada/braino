// Reindexer. Rebuilds search/embedding data in Postgres from the
// source-of-truth entity rows that already live in Postgres. Graph edges are
// first-class rows and are not derived during indexing.

import {
  ALL_ENTITY_TABLES,
  type EmbeddingInput,
  type EmbeddingProviderLike,
  type EmbeddingsReport,
  chunkText,
  nodeIndexText as indexTextOf,
  rebuildDocoDerivedData,
  upsertEmbeddings,
  withClient,
} from "@doco/db";
import type { LoadedDoco, LoadedEntity } from "@doco/shared";
import { entityTypeFromId } from "./entity-id.js";
import { loadDocoFromPostgres } from "./loadDoco.js";

/**
 * The text to index for a loaded node — its FTS body and its embedding
 * input: the node's `prose`, or its identifying fields while the prose is
 * empty (see @doco/db's `nodeIndexText`, which the embedding sweep shares).
 */
export function nodeIndexText(le: LoadedEntity): string {
  return indexTextOf(le.parsed.prose, (le.parsed.data ?? {}) as Record<string, unknown>);
}

export interface BuildReport {
  inserted: number;
  durationMs: number;
  /**
   * Wall-clock time spent inside `loadDocoFromPostgres` (PG read +
   * row hydration). Surfaced so the capture-path telemetry can detect
   * a regression that pulls the loader back to a full-Doco read.
   */
  loadMs: number;
  /**
   * Number of LoadedEntity rows the loader produced. Should match the
   * length of `changedEntityIds` on the incremental path; if it ever
   * spikes for a single-entity capture, the scope-on-load fix has
   * regressed.
   */
  loadedEntityCount: number;
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
   * only — wipe and re-insert just their FTS rows,
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
   * rebuild (FTS) from the slower OpenAI-bound embedding
   * pass — the structural pass runs inline so the response reflects
   * a fresh graph, while embeddings are offloaded to `waitUntil` and
   * caught up after the response is sent.
   */
  skipEmbeddings?: boolean;
  /**
   * When true, skip the FTS rebuild. Paired with the above:
   * the capture flow first runs `{ skipEmbeddings: true }` inline,
   * then `{ skipStructural: true }` in `waitUntil` so the embedding
   * pass catches up off the request path.
   */
  skipStructural?: boolean;
}

/**
 * Rebuild derived data (FTS, embeddings) for one Doco. Caller
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
  const loadedEntityCount = loaded.entities.size;

  let inserted = 0;
  if (!opts.skipStructural) {
    const pgFts: {
      entity_id: string;
      node_type: string;
      summary: string | null;
      body: string;
    }[] = [];
    for (const le of loaded.entities.values()) {
      if (incrementalIds && !incrementalIds.has(le.entity.id)) continue;
      // Per-category interfaces carry `node_type`, `policy_kind`, or
      // `kind`; the id prefix is the shared discriminator for derived rows.
      const nodeType = entityTypeFromId(le.entity.id) || "unknown";
      if (!nodeType || nodeType === "unknown") continue; // skip rows with no recoverable type
      inserted++;
      // Node prose (every node, incl. principal) goes into FTS `body`; policy
      // labels use the A-weight `summary` column.
      const typeNamedColumn = ALL_ENTITY_TABLES[nodeType]?.typeNamedColumn;
      let summary: string | null;
      let body: string;
      if (typeNamedColumn) {
        summary = null;
        body = nodeIndexText(le);
      } else {
        const e = le.entity as unknown as Record<string, unknown>;
        summary = typeof e.policy === "string" ? e.policy : "";
        body = "";
      }
      pgFts.push({
        entity_id: le.entity.id,
        node_type: nodeType,
        summary,
        body,
      });
    }
    await rebuildDocoDerivedData(
      docoId,
      pgFts,
      incrementalIds ? { onlyEntityIds: [...incrementalIds] } : {},
    );
  }

  let embeddings: EmbeddingsReport | undefined;
  if (opts.embeddingProvider && !opts.skipEmbeddings) {
    const texts: EmbeddingInput[] = [];
    for (const le of loaded.entities.values()) {
      if (incrementalIds && !incrementalIds.has(le.entity.id)) continue;
      // Nodes (including principals) embed their `prose` verbatim; policies
      // embed `policy`.
      const nodeType = entityTypeFromId(le.entity.id) || "unknown";
      const typeNamedColumn =
        nodeType !== "unknown" ? ALL_ENTITY_TABLES[nodeType]?.typeNamedColumn : undefined;
      let text: string;
      if (typeNamedColumn) {
        text = nodeIndexText(le);
      } else {
        const e = le.entity as unknown as Record<string, unknown>;
        text = typeof e.policy === "string" ? e.policy.trim() : "";
      }
      if (!text) continue;
      texts.push({
        source: "node",
        entity_id: (le.entity as { id: string }).id,
        doco_id: docoId,
        chunks: chunkText(text),
      });
    }
    try {
      // Prune-stale wipes embeddings for entities NOT in `texts`. On
      // an incremental pass we're only passing one entity, so pruning
      // would nuke every other embedding in the Doco — disable.
      const provider = opts.embeddingProvider;
      embeddings = await withClient((c) =>
        upsertEmbeddings(c, texts, provider, { pruneStale: !incrementalIds }),
      );
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
  return {
    inserted,
    durationMs,
    loadMs: 0,
    loadedEntityCount,
    ...(embeddings ? { embeddings } : {}),
  };
}

/**
 * Pass `opts.changedEntityIds` for the incremental path (single-entity
 * captures): only those entities' FTS rows are touched
 * and the embedding pass is scoped to them. Omit for the safe-but-slow
 * full rebuild — first build, bulk import.
 */
export async function reindex(opts: IndexOptions = {}): Promise<BuildReport> {
  const docoId = opts.docoId;
  if (!docoId) {
    throw new Error("reindex requires opts.docoId.");
  }
  const loadStart = performance.now();
  // Pass changedEntityIds to the loader so the incremental capture path
  // only reads the rows it actually indexes (and skips host-wide
  // principal/workspace rows entirely). Full rebuilds omit the
  // option and get the original "load everything" behaviour.
  const loaded = await loadDocoFromPostgres(docoId, {
    ...(opts.changedEntityIds && opts.changedEntityIds.length > 0
      ? { entityIds: opts.changedEntityIds }
      : {}),
  });
  const loadMs = Math.round(performance.now() - loadStart);
  const report = await indexDoco(loaded, opts);
  return { ...report, loadMs };
}
