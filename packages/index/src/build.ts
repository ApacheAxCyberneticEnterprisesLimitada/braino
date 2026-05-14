// PG-only reindexer. Rebuilds the derived-data tables in Postgres
// (`edges`, `entity_fts`, `embeddings`) from the source-of-truth entity
// rows that already live in Postgres. The legacy SQLite cache layer
// (`.doco/cache.db`) has been removed — ADR-023 / ADR-024 are
// superseded by the SQLite-removal migration.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { LoadedDoco } from "@doco/core";
import {
  computeContentHash,
  type EmbeddingProviderLike,
  type EmbeddingsReport,
  rebuildDocoDerivedData,
  upsertEmbeddings,
} from "@doco/db";
import { deriveEdges } from "./edges.js";
import { loadDocoFromPostgres } from "./loadFromPostgres.js";

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
}

/**
 * Rebuild derived data (edges, FTS, embeddings) for one Doco. Caller
 * supplies the pre-loaded LoadedDoco; this function does the PG writes.
 */
export async function indexDoco(
  loaded: LoadedDoco,
  opts: IndexOptions = {},
): Promise<BuildReport> {
  const start = performance.now();

  const docoId = (loaded.doco as { id: string }).id;
  const pgFts: { entity_id: string; node_type: string; summary: string; body: string }[] = [];
  const pgEdges: ReturnType<typeof deriveEdges> = [];
  let inserted = 0;
  for (const le of loaded.entities.values()) {
    inserted++;
    const e = le.entity as unknown as Record<string, unknown>;
    const summary = String(e.summary ?? "");
    let body = le.parsed.body ?? "";
    if (le.entity.node_type === "scope") {
      const extras = [e.purpose, e.guidelines, e.description]
        .filter((s): s is string => typeof s === "string" && s.length > 0)
        .join("\n\n");
      body = body ? `${body}\n\n${extras}` : extras;
    }
    pgFts.push({
      entity_id: le.entity.id,
      node_type: le.entity.node_type as string,
      summary,
      body,
    });
    for (const edge of deriveEdges(le.entity)) {
      pgEdges.push(edge);
    }
  }
  await rebuildDocoDerivedData(docoId, pgFts, pgEdges);

  let embeddings: EmbeddingsReport | undefined;
  if (opts.embeddingProvider) {
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
      embeddings = await upsertEmbeddings(texts, opts.embeddingProvider, {
        pruneStale: true,
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
 * Rebuild PG derived data for the Doco rooted at `docoRoot`. The on-disk
 * `doco.yaml` carries only the Doco id; entity content lives in PG.
 */
export async function reindex(
  docoRoot: string,
  opts: IndexOptions = {},
): Promise<BuildReport> {
  const docoId = readDocoIdFromYaml(docoRoot);
  const loaded = await loadDocoFromPostgres(docoRoot, docoId);
  return indexDoco(loaded, opts);
}

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
