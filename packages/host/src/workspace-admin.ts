import type { CollectionRole, PoolClient } from "@doco/db";

export interface WorkspaceAdminOverview {
  workspace: {
    id: string;
    handle: string;
    name: string;
    constitution: string;
  };
  counts: {
    collections: number;
    records: number;
    collaborators: number;
    connections: number;
    mcpTokens: number;
  };
  activity: {
    activeAgents: {
      last24Hours: number;
      previous24Hours: number;
      last7Days: number;
      last30Days: number;
    };
    queries: {
      last24Hours: number;
      previous24Hours: number;
      byAgentsLast24Hours: number;
    };
    writes: {
      last24Hours: number;
      previous24Hours: number;
      byAgentsLast24Hours: number;
    };
    imports: {
      last24Hours: number;
      previous24Hours: number;
    };
  };
}

export class WorkspaceAdminError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "WorkspaceAdminError";
  }
}

export async function getWorkspaceRole(
  client: PoolClient,
  workspaceId: string,
  userId: string,
): Promise<CollectionRole | null> {
  const found = await client.query<{ role: CollectionRole }>(
    "SELECT role FROM workspace_users WHERE workspace_id = $1 AND user_id = $2",
    [workspaceId, userId],
  );
  return found.rows[0]?.role ?? null;
}

async function requireOwner(
  client: PoolClient,
  workspaceId: string,
  userId: string,
): Promise<void> {
  if ((await getWorkspaceRole(client, workspaceId, userId)) !== "owner") {
    throw new WorkspaceAdminError(
      "Only workspace owners can administer this Braino deployment.",
      "owner_required",
      403,
    );
  }
}

export async function getWorkspaceAdminOverview(
  client: PoolClient,
  input: { workspaceId: string; userId: string; now?: Date },
): Promise<WorkspaceAdminOverview> {
  await requireOwner(client, input.workspaceId, input.userId);
  const workspace = await client.query<WorkspaceAdminOverview["workspace"]>(
    "SELECT id, handle, name, constitution FROM workspaces WHERE id = $1",
    [input.workspaceId],
  );
  const row = workspace.rows[0];
  if (!row) {
    throw new WorkspaceAdminError("The Braino workspace is missing.", "workspace_not_found", 404);
  }
  const counts = await client.query<WorkspaceAdminOverview["counts"]>(
    `SELECT
       (SELECT count(*)::int FROM collections
         WHERE workspace_id = $1 AND deleted_at IS NULL) AS collections,
       (SELECT count(*)::int FROM nodes n
          JOIN collections c ON c.id = n.collection_id
         WHERE c.workspace_id = $1 AND c.deleted_at IS NULL) AS records,
       (SELECT count(*)::int FROM workspace_users WHERE workspace_id = $1) AS collaborators,
       ((SELECT count(*)::int FROM connector_connections
           WHERE workspace_id = $1 AND active)
        + (SELECT count(*)::int FROM github_connections
            WHERE workspace_id = $1 AND active)
        + (SELECT count(*)::int FROM incoming_webhooks h
             JOIN collections c ON c.id = h.collection_id
            WHERE c.workspace_id = $1 AND NOT h.revoked))::int AS connections,
       (SELECT count(*)::int FROM oauth_access_tokens
         WHERE $1 = ANY(granted_workspace_ids) AND NOT revoked AND expires_at > now()) AS "mcpTokens"`,
    [input.workspaceId],
  );
  const activity = await client.query<WorkspaceAdminOverview["activity"]>(
    `WITH bounds AS (
       SELECT $2::timestamptz AS now,
              $2::timestamptz - interval '24 hours' AS day,
              $2::timestamptz - interval '48 hours' AS previous_day,
              $2::timestamptz - interval '7 days' AS week,
              $2::timestamptz - interval '30 days' AS month
     ), agent_activity AS (
       SELECT q.actor,
              coalesce(nullif(q.metadata->>'client', ''),
                       nullif(q.metadata->>'token_name', ''),
                       nullif(q.metadata->>'client_name', ''),
                       CASE q.source WHEN 'mcp' THEN 'MCP' ELSE 'API' END) AS agent,
              q.at
         FROM query_events q
        WHERE q.workspace_id = $1 AND q.actor IS NOT NULL
          AND (q.source = 'mcp' OR (q.source = 'api' AND q.metadata ? 'auth'))
       UNION ALL
       SELECT cs.actor,
              coalesce(nullif(cs.metadata->>'client', ''),
                       nullif(cs.metadata->>'token_name', ''),
                       nullif(cs.metadata->>'client_name', ''),
                       CASE cs.source WHEN 'mcp' THEN 'MCP' ELSE 'API' END) AS agent,
              cs.recorded_at AS at
         FROM changesets cs
         JOIN collections c ON c.id = cs.collection_id
        WHERE c.workspace_id = $1 AND cs.actor IS NOT NULL
          AND (cs.source = 'mcp' OR (cs.source = 'api' AND cs.metadata ? 'auth'))
     ), workspace_writes AS (
       SELECT cs.recorded_at AS at, cs.source, cs.metadata
         FROM changesets cs
         JOIN collections c ON c.id = cs.collection_id
        WHERE c.workspace_id = $1
          AND cs.source <> 'import'
          AND (cs.source <> 'api' OR coalesce(cs.metadata ? 'auth', false))
          AND NOT EXISTS (
            SELECT 1 FROM node_versions v
             WHERE v.tx_id = cs.tx_id AND v.entity_type = 'policy'
          )
     ), workspace_imports AS (
       SELECT i.at
         FROM imported_items i
         JOIN collections c ON c.id = i.collection_id
        WHERE c.workspace_id = $1
     )
     SELECT
       jsonb_build_object(
         'last24Hours', COUNT(DISTINCT (a.actor, a.agent))
           FILTER (WHERE a.at >= b.day AND a.at < b.now),
         'previous24Hours', COUNT(DISTINCT (a.actor, a.agent))
           FILTER (WHERE a.at >= b.previous_day AND a.at < b.day),
         'last7Days', COUNT(DISTINCT (a.actor, a.agent))
           FILTER (WHERE a.at >= b.week AND a.at < b.now),
         'last30Days', COUNT(DISTINCT (a.actor, a.agent))
           FILTER (WHERE a.at >= b.month AND a.at < b.now)
       ) AS "activeAgents",
       jsonb_build_object(
         'last24Hours', (SELECT COUNT(*) FROM query_events q
                          WHERE q.workspace_id = $1 AND q.at >= b.day AND q.at < b.now),
         'previous24Hours', (SELECT COUNT(*) FROM query_events q
                              WHERE q.workspace_id = $1
                                AND q.at >= b.previous_day AND q.at < b.day),
         'byAgentsLast24Hours', (SELECT COUNT(*) FROM query_events q
                                  WHERE q.workspace_id = $1
                                    AND q.at >= b.day AND q.at < b.now
                                    AND (q.source = 'mcp'
                                      OR (q.source = 'api' AND q.metadata ? 'auth')))
       ) AS queries,
       jsonb_build_object(
         'last24Hours', (SELECT COUNT(*) FROM workspace_writes w
                          WHERE w.at >= b.day AND w.at < b.now),
         'previous24Hours', (SELECT COUNT(*) FROM workspace_writes w
                              WHERE w.at >= b.previous_day AND w.at < b.day),
         'byAgentsLast24Hours', (SELECT COUNT(*) FROM workspace_writes w
                                  WHERE w.at >= b.day AND w.at < b.now
                                    AND (w.source = 'mcp'
                                      OR (w.source = 'api' AND w.metadata ? 'auth')))
       ) AS writes,
       jsonb_build_object(
         'last24Hours', (SELECT COUNT(*) FROM workspace_imports i
                          WHERE i.at >= b.day AND i.at < b.now),
         'previous24Hours', (SELECT COUNT(*) FROM workspace_imports i
                              WHERE i.at >= b.previous_day AND i.at < b.day)
       ) AS imports
       FROM bounds b
       LEFT JOIN agent_activity a ON a.at >= b.month AND a.at < b.now
      GROUP BY b.now, b.day, b.previous_day, b.week, b.month`,
    [input.workspaceId, (input.now ?? new Date()).toISOString()],
  );
  return {
    workspace: row,
    counts: counts.rows[0] as WorkspaceAdminOverview["counts"],
    activity: activity.rows[0] as WorkspaceAdminOverview["activity"],
  };
}

export async function updateWorkspaceSettings(
  client: PoolClient,
  input: {
    workspaceId: string;
    userId: string;
    name: string;
    constitution: string;
  },
): Promise<WorkspaceAdminOverview["workspace"]> {
  await requireOwner(client, input.workspaceId, input.userId);
  const name = input.name.trim();
  if (!name) {
    throw new WorkspaceAdminError("Workspace name is required.", "name_required");
  }
  const updated = await client.query<WorkspaceAdminOverview["workspace"]>(
    `UPDATE workspaces
        SET name = $2, constitution = $3, updated_at = now()
      WHERE id = $1
      RETURNING id, handle, name, constitution`,
    [input.workspaceId, name, input.constitution.trim()],
  );
  const row = updated.rows[0];
  if (!row) {
    throw new WorkspaceAdminError("The Braino workspace is missing.", "workspace_not_found", 404);
  }
  return row;
}
