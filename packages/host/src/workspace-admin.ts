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
  input: { workspaceId: string; userId: string },
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
  return { workspace: row, counts: counts.rows[0] as WorkspaceAdminOverview["counts"] };
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
