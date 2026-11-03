import { createHash } from "node:crypto";
import type { QueryClient } from "@doco/db";
import {
  COLLECTION_RELATIONSHIP_PIPELINE_VERSION,
  type CollectionRelationshipModel,
  type CollectionSummaryResult,
  type CollectionSummarySource,
} from "./collection-relationship-model.js";
import { replaceWorkspaceRelationships } from "./collection-relationship-store.js";
import {
  type CollectionSummaryDigest,
  normalizeCollectionRelationshipDirections,
  validateCollectionRelationships,
} from "./collection-relationship-validation.js";

const SOURCES_PER_KIND = 8;
const SOURCES_PER_SUMMARY = 8;
const SOURCE_EXCERPT_CHARS = 600;
const COLLECTION_GOAL_CHARS = 600;

interface CollectionStateRow {
  collection_id: string;
  workspace_id: string;
  handle: string;
  kind: string;
  goal: string;
  source_fingerprint: string | null;
  source_count: number | string;
  source_changed_at: string | Date | null;
  stored_source_version: string | null;
  stored_summary_version: string | null;
  stored_relationships_version: string | null;
  stored_model_id: string | null;
  summarized_at: string | Date | null;
  relationship_failed_at: string | Date | null;
}

interface CollectionState extends CollectionStateRow {
  sourceVersion: string;
  summaryVersion: string;
  needsSummary: boolean;
}

interface WorkspaceGraphState {
  workspaceId: string;
  relationshipVersion: string;
  failedAt: string | Date | null;
}

interface SummaryRow {
  collection_id: string;
  handle: string;
  kind: string;
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

function version(prefix: "summary" | "relationships", parts: readonly unknown[]): string {
  const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `${prefix}_${digest.slice(0, 24)}`;
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

async function collectionStates(c: QueryClient, modelId: string): Promise<CollectionState[]> {
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
     ), relationship_counts AS (
       SELECT workspace_id, count(*)::int AS relationship_count
         FROM collection_relationships
        GROUP BY workspace_id
     )
     SELECT c.id AS collection_id, c.workspace_id, c.handle,
            coalesce(nullif(c.data->>'template_handle', ''), 'generic') AS kind,
            c.goal,
            s.source_fingerprint, coalesce(s.source_count, 0)::int AS source_count,
            s.source_changed_at,
            cs.source_version AS stored_source_version,
            cs.summary_version AS stored_summary_version,
            cs.relationships_version AS stored_relationships_version,
            cs.model_id AS stored_model_id,
            cs.summarized_at,
            rf.failed_at AS relationship_failed_at
       FROM collections c
       LEFT JOIN source_states s ON s.collection_id = c.id
       LEFT JOIN collection_summaries cs ON cs.collection_id = c.id
       LEFT JOIN collection_summary_failures sf ON sf.collection_id = c.id
       LEFT JOIN relationship_counts rc ON rc.workspace_id = c.workspace_id
       LEFT JOIN collection_relationship_failures rf ON rf.workspace_id = c.workspace_id
      WHERE c.deleted_at IS NULL
      ORDER BY (sf.collection_id IS NOT NULL),
               sf.failed_at ASC NULLS FIRST,
               coalesce(rc.relationship_count, 0) DESC,
               (cs.collection_id IS NOT NULL),
               s.source_changed_at DESC NULLS LAST,
               cs.summarized_at NULLS FIRST,
               c.workspace_id, c.id`,
  );
  return rows.rows.map((row) => {
    const sourceVersion = version("summary", [
      row.handle,
      row.kind,
      row.goal,
      row.source_fingerprint ?? "empty",
      Number(row.source_count),
    ]);
    const summaryVersion = version("summary", [
      COLLECTION_RELATIONSHIP_PIPELINE_VERSION,
      modelId,
      sourceVersion,
    ]);
    const needsSummary =
      row.stored_source_version !== sourceVersion ||
      row.stored_summary_version !== summaryVersion ||
      row.stored_model_id !== modelId;
    return { ...row, sourceVersion, summaryVersion, needsSummary };
  });
}

function staleWorkspaceGraphs(
  states: readonly CollectionState[],
  modelId: string,
): WorkspaceGraphState[] {
  const byWorkspace = new Map<string, CollectionState[]>();
  for (const state of states) {
    const workspace = byWorkspace.get(state.workspace_id) ?? [];
    workspace.push(state);
    byWorkspace.set(state.workspace_id, workspace);
  }

  const stale: WorkspaceGraphState[] = [];
  for (const [workspaceId, workspace] of byWorkspace) {
    if (workspace.some((collection) => collection.needsSummary)) continue;
    const relationshipVersion = version("relationships", [
      COLLECTION_RELATIONSHIP_PIPELINE_VERSION,
      modelId,
      ...workspace
        .map((collection) => [collection.collection_id, collection.summaryVersion] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    ]);
    if (
      workspace.some(
        (collection) => collection.stored_relationships_version !== relationshipVersion,
      )
    ) {
      stale.push({
        workspaceId,
        relationshipVersion,
        failedAt: workspace[0]?.relationship_failed_at ?? null,
      });
    }
  }
  return stale.sort((left, right) => {
    if ((left.failedAt === null) !== (right.failedAt === null)) {
      return left.failedAt === null ? -1 : 1;
    }
    if (left.failedAt !== null && right.failedAt !== null) {
      const age = new Date(left.failedAt).getTime() - new Date(right.failedAt).getTime();
      if (age !== 0) return age;
    }
    return left.workspaceId.localeCompare(right.workspaceId);
  });
}

function pendingWorkCount(states: readonly CollectionState[], modelId: string): number {
  return (
    states.filter((collection) => collection.needsSummary).length +
    staleWorkspaceGraphs(states, modelId).length
  );
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
  input: CollectionState,
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

async function clearSummaryFailure(c: QueryClient, collectionId: string): Promise<void> {
  await c.query("DELETE FROM collection_summary_failures WHERE collection_id = $1", [collectionId]);
}

async function recordSummaryFailure(
  c: QueryClient,
  collectionId: string,
  error: string,
): Promise<void> {
  await c.query(
    `INSERT INTO collection_summary_failures (collection_id, failed_at, error)
     VALUES ($1, now(), $2)
     ON CONFLICT (collection_id) DO UPDATE SET failed_at = now(), error = EXCLUDED.error`,
    [collectionId, error],
  );
}

async function workspaceSummaries(
  c: QueryClient,
  workspaceId: string,
): Promise<CollectionSummaryDigest[]> {
  const rows = await c.query<SummaryRow>(
    `SELECT cs.collection_id, c.handle,
            coalesce(nullif(c.data->>'template_handle', ''), 'generic') AS kind,
            cs.summary_version, cs.digest, cs.evidence_ids
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
    kind: row.kind,
    digest: row.digest,
    summaryVersion: row.summary_version,
    evidenceIds: textArray(row.evidence_ids),
  }));
}

async function markRelationshipsCurrent(
  c: QueryClient,
  workspaceId: string,
  relationshipVersion: string,
): Promise<void> {
  await c.query(
    `UPDATE collection_summaries
        SET relationships_version = $2
      WHERE workspace_id = $1`,
    [workspaceId, relationshipVersion],
  );
}

async function clearRelationshipFailure(c: QueryClient, workspaceId: string): Promise<void> {
  await c.query("DELETE FROM collection_relationship_failures WHERE workspace_id = $1", [
    workspaceId,
  ]);
}

async function recordRelationshipFailure(
  c: QueryClient,
  workspaceId: string,
  error: string,
): Promise<void> {
  await c.query(
    `INSERT INTO collection_relationship_failures (workspace_id, failed_at, error)
     VALUES ($1, now(), $2)
     ON CONFLICT (workspace_id) DO UPDATE SET failed_at = now(), error = EXCLUDED.error`,
    [workspaceId, error],
  );
}

/**
 * Advance the derived graph in two durable stages: summarize changed
 * collections, then infer one complete graph after every summary in a
 * workspace is current. A graph failure retries without paying for summaries
 * again, and no collection is ever compared against a partial workspace.
 */
export async function sweepCollectionRelationships(
  c: QueryClient,
  args: { model: CollectionRelationshipModel; limit?: number },
): Promise<CollectionRelationshipSweepResult> {
  const limit = Math.max(1, Math.min(10, Math.floor(args.limit ?? 1)));
  const result: CollectionRelationshipSweepResult = {
    processed: 0,
    summarized: 0,
    accepted: 0,
    rejected: 0,
    failures: [],
    pending: 0,
  };

  const initialStates = await collectionStates(c, args.model.id);
  const pendingSummaries = initialStates.filter((collection) => collection.needsSummary);
  const staleGraphs = staleWorkspaceGraphs(initialStates, args.model.id);
  const graphToRefresh =
    staleGraphs.find((graph) => graph.failedAt === null) ??
    (pendingSummaries.length === 0 ? staleGraphs[0] : undefined);

  if (graphToRefresh) {
    result.processed++;
    try {
      const summaries = await workspaceSummaries(c, graphToRefresh.workspaceId);
      const inferred = summaries.length < 2 ? [] : await args.model.infer({ summaries });
      const validation = validateCollectionRelationships(
        { summaries },
        normalizeCollectionRelationshipDirections(summaries, inferred),
      );
      await replaceWorkspaceRelationships(c, {
        workspaceId: graphToRefresh.workspaceId,
        relationships: validation.accepted,
      });
      await markRelationshipsCurrent(
        c,
        graphToRefresh.workspaceId,
        graphToRefresh.relationshipVersion,
      );
      await clearRelationshipFailure(c, graphToRefresh.workspaceId);
      result.accepted += validation.accepted.length;
      result.rejected += validation.rejected.length;
    } catch (error) {
      const message = errorMessage(error);
      await recordRelationshipFailure(c, graphToRefresh.workspaceId, message);
      result.failures.push({
        collectionId: graphToRefresh.workspaceId,
        error: message,
      });
    }

    const finalStates = await collectionStates(c, args.model.id);
    result.pending = pendingWorkCount(finalStates, args.model.id);
    return result;
  }

  const prioritizedWorkspaceId = pendingSummaries[0]?.workspace_id;
  const prioritizedWorkspaceSummaries = pendingSummaries.filter(
    (collection) => collection.workspace_id === prioritizedWorkspaceId,
  );
  const summariesToRefresh = prioritizedWorkspaceSummaries.slice(0, limit);
  for (const collection of summariesToRefresh) {
    result.processed++;
    try {
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
                kind: collection.kind,
                goal: collection.goal.slice(0, COLLECTION_GOAL_CHARS),
                sources,
              }),
              sources,
            );
      await saveSummary(c, collection, args.model.id, summary);
      await clearSummaryFailure(c, collection.collection_id);
      result.summarized++;
    } catch (error) {
      const message = errorMessage(error);
      await recordSummaryFailure(c, collection.collection_id, message);
      result.failures.push({
        collectionId: collection.collection_id,
        error: message,
      });
      break;
    }
  }

  const finalStates = await collectionStates(c, args.model.id);
  result.pending = pendingWorkCount(finalStates, args.model.id);
  return result;
}
