import type { PoolClient } from "@doco/db";
import {
  resetNodeSearchProjection,
  syncNodeSearchProjection,
} from "@doco/index/qdrant-record-projection";
import { QdrantVectorStore, type RetrievalStore } from "@doco/index/qdrant-vector-store";

export interface WorkspaceSearchResult {
  id: string;
  collection_id: string;
  collection_handle: string;
  node_type: string;
  lifecycle: string;
  title: string;
  excerpt: string;
  locator: string | null;
  updated_at: string;
}

export interface WorkspaceSearchOptions {
  retrievalStore?: RetrievalStore | null;
}

let runtimeStore: { key: string; store: RetrievalStore } | undefined;

function configuredRetrievalStore(): RetrievalStore | null {
  const url = process.env.QDRANT_URL?.trim();
  if (!url) return null;
  const apiKey = process.env.QDRANT_API_KEY?.trim();
  const key = `${url}\n${apiKey ?? ""}`;
  if (runtimeStore?.key !== key) {
    runtimeStore = {
      key,
      store: new QdrantVectorStore({
        url,
        ...(apiKey ? { apiKey } : {}),
        collection: "doco_records",
        dimensions: 1,
        timeoutMs: 3_000,
      }),
    };
  }
  return runtimeStore.store;
}

async function qdrantResults(
  client: PoolClient,
  input: { workspaceId: string; userId: string; query: string },
  limit: number,
  store: RetrievalStore,
): Promise<WorkspaceSearchResult[]> {
  const collectionIds = (
    await client.query<{ id: string }>(
      `SELECT c.id
         FROM collections c
        WHERE c.workspace_id = $1 AND c.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM workspace_users wu
             WHERE wu.workspace_id = c.workspace_id AND wu.user_id = $2
          )
        ORDER BY c.id`,
      [input.workspaceId, input.userId],
    )
  ).rows.map((row) => row.id);
  if (collectionIds.length === 0) return [];

  const collection = await store.ensureCollection?.();
  if (collection?.created) await resetNodeSearchProjection(client);
  await syncNodeSearchProjection(client, store, { batchSize: 256 });
  const hits = await store.rankLexical({
    collectionIds,
    source: "node",
    queryText: input.query,
    limit: limit * 2,
  });
  if (hits.length === 0) return [];

  const rows = (
    await client.query<WorkspaceSearchResult>(
      `SELECT n.id, n.collection_id, c.handle AS collection_handle,
              n.node_type, n.lifecycle,
              coalesce(nullif(n.extra->>'title', ''), nullif(n.extra->>'name', ''),
                       nullif(split_part(n.prose, E'\n', 1), ''), n.id) AS title,
              left(n.prose, 360) AS excerpt,
              n.locator, n.updated_at::text
         FROM nodes n
         JOIN collections c ON c.id = n.collection_id AND c.deleted_at IS NULL
        WHERE n.collection_id = ANY($1::text[])
          AND n.id = ANY($2::text[])
          AND c.workspace_id = $3
          AND EXISTS (
            SELECT 1 FROM workspace_users wu
             WHERE wu.workspace_id = c.workspace_id AND wu.user_id = $4
          )`,
      [collectionIds, hits.map((hit) => hit.entity_id), input.workspaceId, input.userId],
    )
  ).rows;
  const byKey = new Map(rows.map((row) => [`${row.collection_id}\n${row.id}`, row]));
  return hits
    .map((hit) => byKey.get(`${hit.collection_id}\n${hit.entity_id}`))
    .filter((row): row is WorkspaceSearchResult => row !== undefined);
}

export async function searchWorkspaceRecords(
  client: PoolClient,
  input: { workspaceId: string; userId: string; query: string; limit?: number },
  options: WorkspaceSearchOptions = {},
): Promise<WorkspaceSearchResult[]> {
  const query = input.query.trim();
  if (!query) return [];
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 30)));
  const found = await client.query<WorkspaceSearchResult>(
    `WITH search AS (
       SELECT websearch_to_tsquery('simple', $3) AS terms, lower($3) AS exact
     ), candidates AS (
       SELECT n.id, n.collection_id, c.handle AS collection_handle,
              n.node_type, n.lifecycle,
              coalesce(nullif(n.extra->>'title', ''), nullif(n.extra->>'name', ''),
                       nullif(split_part(n.prose, E'\n', 1), ''), n.id) AS title,
              left(n.prose, 360) AS excerpt,
              n.locator,
              n.updated_at,
              CASE
                WHEN lower(n.id) = search.exact THEN 10000
                WHEN lower(coalesce(nullif(n.extra->>'title', ''), nullif(n.extra->>'name', ''),
                                    nullif(split_part(n.prose, E'\n', 1), ''), n.id)) = search.exact
                  THEN 9000
                WHEN lower(coalesce(nullif(n.extra->>'title', ''), nullif(n.extra->>'name', ''),
                                    nullif(split_part(n.prose, E'\n', 1), ''), n.id)) LIKE search.exact || '%'
                  THEN 8000
                ELSE ts_rank_cd(
                  to_tsvector('simple', concat_ws(' ', n.id, n.prose, n.locator,
                    n.extra->>'title', n.extra->>'name')),
                  search.terms
                )
              END AS relevance
         FROM nodes n
         JOIN collections c ON c.id = n.collection_id AND c.deleted_at IS NULL
         JOIN search ON true
        WHERE c.workspace_id = $1
          AND EXISTS (
            SELECT 1 FROM workspace_users wu
             WHERE wu.workspace_id = c.workspace_id AND wu.user_id = $2
          )
          AND (
            lower(n.id) = search.exact
            OR lower(coalesce(nullif(n.extra->>'title', ''), nullif(n.extra->>'name', ''),
                              nullif(split_part(n.prose, E'\n', 1), ''), n.id)) = search.exact
            OR to_tsvector('simple', concat_ws(' ', n.id, n.prose, n.locator,
                 n.extra->>'title', n.extra->>'name')) @@ search.terms
          )
     )
     SELECT id, collection_id, collection_handle, node_type, lifecycle, title, excerpt,
            locator, updated_at::text
       FROM candidates
      ORDER BY relevance DESC, updated_at DESC, id
      LIMIT $4`,
    [input.workspaceId, input.userId, query, limit],
  );
  const store =
    options.retrievalStore === undefined ? configuredRetrievalStore() : options.retrievalStore;
  if (!store) return found.rows;

  try {
    const projected = await qdrantResults(
      client,
      { workspaceId: input.workspaceId, userId: input.userId, query },
      limit,
      store,
    );
    const exact = query.toLowerCase();
    const exactPostgres = found.rows.filter(
      (row) => row.id.toLowerCase() === exact || row.title.toLowerCase() === exact,
    );
    const merged = [...exactPostgres, ...projected, ...found.rows];
    return [...new Map(merged.map((row) => [row.id, row])).values()].slice(0, limit);
  } catch (error) {
    console.warn(
      "Qdrant search projection is unavailable; using PostgreSQL search.",
      error instanceof Error ? error.message : String(error),
    );
    return found.rows;
  }
}
