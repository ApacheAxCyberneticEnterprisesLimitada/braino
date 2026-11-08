import type { PoolClient } from "@doco/db";

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

export async function searchWorkspaceRecords(
  client: PoolClient,
  input: { workspaceId: string; userId: string; query: string; limit?: number },
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
  return found.rows;
}
