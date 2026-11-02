import { createHash } from "node:crypto";
import type { QueryClient } from "@doco/db";
import type {
  CollectionRelationshipModel,
  CollectionSummaryResult,
  CollectionSummarySource,
} from "./collection-relationship-model.js";
import { replaceCollectionRelationships } from "./collection-relationship-store.js";
import {
  type CollectionSummaryDigest,
  validateCollectionRelationships,
} from "./collection-relationship-validation.js";

const SOURCES_PER_KIND = 6;
const SOURCES_PER_SUMMARY = 30;
const SOURCE_EXCERPT_CHARS = 1_200;

interface CollectionStateRow {
  collection_id: string;
  workspace_id: string;
  handle: string;
  goal: string;
  source_fingerprint: string | null;
  source_count: number | string;
  source_changed_at: string | Date | null;
  stored_source_version: string | null;
  stored_summary_version: string | null;
  stored_relationships_version: string | null;
  stored_model_id: string | null;
  summarized_at: string | Date | null;
}

interface PendingCollection extends CollectionStateRow {
  sourceVersion: string;
  summaryVersion: string;
  needsSummary: boolean;
}

interface SummaryRow {
  collection_id: string;
  handle: string;
  summary_version: string;
  digest: string;
  evidence_ids: string[] | string;
}

interface SourceRow {
  source: string;
  external_id: string;
  title: string | null;
  content: string;
}

export interface CollectionRelationshipSweepFailure {
  collectionId: string;
  error: string;
}

export interface CollectionRelationshipSweepResult {
  processed: number;
  summarized: number;
  accepted: number;
  rejected: number;
  failures: CollectionRelationshipSweepFailure[];
  pending: number;
}

function version(parts: readonly (string | number)[]): string {
  const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `summary_${digest.slice(0, 24)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function textArray(value: string[] | string): string[] {
  if (Array.isArray(value)) return value;
  if (value.startsWith("{") && value.endsWith("}")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => item.replace(/^"|"$/g, ""))
      .filter(Boolean);
  }
  return [];
}

function checkedSummary(
  summary: CollectionSummaryResult,
  sources: readonly CollectionSummarySource[],
): CollectionSummaryResult {
  if (!summary.digest.trim() || summary.evidenceIds.length === 0) {
    throw new Error("Collection summary requires a digest and evidence");
  }
  const allowed = new Set(sources.map((source) => source.evidenceId));
  if (summary.evidenceIds.some((id) => !allowed.has(id))) {
    throw new Error("Collection summary cited unknown evidence");
  }
  return {
    digest: summary.digest.trim(),
    evidenceIds: [...new Set(summary.evidenceIds)].sort(),
  };
}

async function collectionStates(c: QueryClient, modelId: string): Promise<PendingCollection[]> {
  const rows = await c.query<CollectionStateRow>(
    `WITH source_states AS (
       SELECT collection_id,
              md5(string_agg(
                md5(source || E'\n' || external_id || E'\n' || coalesce(source_updated_at::text, '')),
                '' ORDER BY source, external_id
              )) AS source_fingerprint,
              count(*)::int AS source_count,
              max(source_updated_at) AS source_changed_at
         FROM retrieval_source_documents
        GROUP BY collection_id
     )
     SELECT c.id AS collection_id, c.workspace_id, c.handle, c.goal,
            s.source_fingerprint, coalesce(s.source_count, 0)::int AS source_count,
            s.source_changed_at,
            cs.source_version AS stored_source_version,
            cs.summary_version AS stored_summary_version,
            cs.relationships_version AS stored_relationships_version,
            cs.model_id AS stored_model_id,
            cs.summarized_at
       FROM collections c
       LEFT JOIN source_states s ON s.collection_id = c.id
       LEFT JOIN collection_summaries cs ON cs.collection_id = c.id
      WHERE c.deleted_at IS NULL
      ORDER BY (cs.collection_id IS NOT NULL),
               s.source_changed_at DESC NULLS LAST,
               cs.summarized_at NULLS FIRST,
               c.workspace_id, c.id`,
  );
  const pending: PendingCollection[] = [];
  for (const row of rows.rows) {
    const sourceVersion = version([
      row.handle,
      row.goal,
      row.source_fingerprint ?? "empty",
      Number(row.source_count),
    ]);
    const summaryVersion = version([modelId, sourceVersion]);
    const needsSummary =
      row.stored_source_version !== sourceVersion ||
      row.stored_summary_version !== summaryVersion ||
      row.stored_model_id !== modelId;
    if (needsSummary || row.stored_relationships_version !== summaryVersion) {
      pending.push({ ...row, sourceVersion, summaryVersion, needsSummary });
    }
  }
  return pending;
}

async function collectionSources(
  c: QueryClient,
  collectionId: string,
): Promise<CollectionSummarySource[]> {
  const rows = await c.query<SourceRow>(
    `WITH ranked AS (
       SELECT source, external_id, title, content, source_updated_at,
              row_number() OVER (
                PARTITION BY source ORDER BY source_updated_at DESC NULLS LAST, external_id
              ) AS source_rank
         FROM retrieval_source_documents
        WHERE collection_id = $1
     )
     SELECT source, external_id, title, content
       FROM ranked
      WHERE source_rank <= $2
      ORDER BY source_updated_at DESC NULLS LAST, source, external_id
      LIMIT $3`,
    [collectionId, SOURCES_PER_KIND, SOURCES_PER_SUMMARY],
  );
  return rows.rows.map((row) => ({
    evidenceId: `${row.source}:${row.external_id}`,
    title: row.title,
    content: row.content.slice(0, SOURCE_EXCERPT_CHARS),
  }));
}

async function saveSummary(
  c: QueryClient,
  input: PendingCollection,
  modelId: string,
  summary: CollectionSummaryResult,
): Promise<void> {
  await c.query(
    `INSERT INTO collection_summaries
       (collection_id, workspace_id, source_version, summary_version,
        model_id, digest, evidence_ids, summarized_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::text[], now())
     ON CONFLICT (collection_id) DO UPDATE SET
       workspace_id = EXCLUDED.workspace_id,
       source_version = EXCLUDED.source_version,
       summary_version = EXCLUDED.summary_version,
       relationships_version = CASE
         WHEN collection_summaries.summary_version = EXCLUDED.summary_version
         THEN collection_summaries.relationships_version
         ELSE NULL
       END,
       model_id = EXCLUDED.model_id,
       digest = EXCLUDED.digest,
       evidence_ids = EXCLUDED.evidence_ids,
       summarized_at = now()`,
    [
      input.collection_id,
      input.workspace_id,
      input.sourceVersion,
      input.summaryVersion,
      modelId,
      summary.digest,
      summary.evidenceIds,
    ],
  );
}

async function workspaceSummaries(
  c: QueryClient,
  workspaceId: string,
): Promise<CollectionSummaryDigest[]> {
  const rows = await c.query<SummaryRow>(
    `SELECT cs.collection_id, c.handle, cs.summary_version, cs.digest, cs.evidence_ids
       FROM collection_summaries cs
       JOIN collections c ON c.id = cs.collection_id AND c.deleted_at IS NULL
      WHERE cs.workspace_id = $1
        AND cardinality(cs.evidence_ids) > 0
      ORDER BY c.handle, c.id`,
    [workspaceId],
  );
  return rows.rows.map((row) => ({
    collectionId: row.collection_id,
    name: row.handle,
    digest: row.digest,
    summaryVersion: row.summary_version,
    evidenceIds: textArray(row.evidence_ids),
  }));
}

async function markRelationshipsCurrent(
  c: QueryClient,
  collectionId: string,
  summaryVersion: string,
): Promise<void> {
  await c.query(
    `UPDATE collection_summaries
        SET relationships_version = $2
      WHERE collection_id = $1 AND summary_version = $2`,
    [collectionId, summaryVersion],
  );
}

/**
 * Advance the derived collection graph by a bounded number of stale anchors.
 * Durable versions split summary work from inference work, so a failed second
 * model call retries without paying for the first one again.
 */
export async function sweepCollectionRelationships(
  c: QueryClient,
  args: { model: CollectionRelationshipModel; limit?: number },
): Promise<CollectionRelationshipSweepResult> {
  const limit = Math.max(1, Math.min(10, Math.floor(args.limit ?? 1)));
  const pending = await collectionStates(c, args.model.id);
  const selected = pending.slice(0, limit);
  const result: CollectionRelationshipSweepResult = {
    processed: 0,
    summarized: 0,
    accepted: 0,
    rejected: 0,
    failures: [],
    pending: Math.max(0, pending.length - selected.length),
  };

  for (const collection of selected) {
    result.processed++;
    try {
      if (collection.needsSummary) {
        const sources = await collectionSources(c, collection.collection_id);
        const summary =
          sources.length === 0
            ? {
                digest:
                  collection.goal.trim() ||
                  `${collection.handle} does not contain source evidence yet.`,
                evidenceIds: [],
              }
            : checkedSummary(
                await args.model.summarize({
                  collectionId: collection.collection_id,
                  name: collection.handle,
                  goal: collection.goal,
                  sources,
                }),
                sources,
              );
        await saveSummary(c, collection, args.model.id, summary);
        result.summarized++;
      }

      const summaries = await workspaceSummaries(c, collection.workspace_id);
      const anchor = summaries.find((summary) => summary.collectionId === collection.collection_id);
      if (!anchor) {
        await replaceCollectionRelationships(c, {
          workspaceId: collection.workspace_id,
          anchorId: collection.collection_id,
          relationships: [],
        });
        await markRelationshipsCurrent(c, collection.collection_id, collection.summaryVersion);
        continue;
      }

      const inferred = await args.model.infer({
        anchorId: collection.collection_id,
        summaries,
      });
      const validation = validateCollectionRelationships(
        { anchorId: collection.collection_id, summaries },
        inferred,
      );
      await replaceCollectionRelationships(c, {
        workspaceId: collection.workspace_id,
        anchorId: collection.collection_id,
        relationships: validation.accepted,
      });
      await markRelationshipsCurrent(c, collection.collection_id, collection.summaryVersion);
      result.accepted += validation.accepted.length;
      result.rejected += validation.rejected.length;
    } catch (error) {
      result.failures.push({
        collectionId: collection.collection_id,
        error: errorMessage(error),
      });
    }
  }
  return result;
}
