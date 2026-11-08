import {
  type PoolClient,
  appendAuditEventRow,
  appendNodeVersion,
  createChangeset,
  nodeRowFromFields,
  upsertNode,
} from "@doco/db";
import { generateUlid, makeEntityId } from "@doco/shared";
import { createCollectionInWorkspace } from "./host.js";
import { openSecret, sealSecret } from "./secret-box.js";

const API = "https://api.github.com";
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class GithubConnectionError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "GithubConnectionError";
  }
}

export interface GithubConnectionSummary {
  id: string;
  repository: string;
  issuesCollectionHandle: string;
  pullRequestsCollectionHandle: string;
  active: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
}

type Fetcher = typeof fetch;

interface ConnectionRow {
  id: string;
  workspace_id: string;
  repository: string;
  token_sealed: string | null;
  issues_collection_id: string;
  pull_requests_collection_id: string;
  created_by_user_id: string;
  active: boolean;
}

interface GithubItem {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: "open" | "closed";
  created_at: string;
  updated_at: string;
  user?: { login?: string } | null;
  labels?: Array<{ name?: string } | string>;
  comments?: number;
  locked?: boolean;
  pull_request?: unknown;
  draft?: boolean;
  merged_at?: string | null;
  head?: { ref?: string };
  base?: { ref?: string };
}

interface StoredNode {
  id: string;
  node_type: string;
  lifecycle: string;
  prose: string;
  kind: string | null;
  locator: string | null;
  extra: Record<string, unknown>;
  created_at: Date | string;
  created_by: string | null;
  updated_at: Date | string;
  updated_by: string | null;
}

function normalizeRepository(value: string): string {
  const repository = value
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "");
  if (!REPOSITORY.test(repository)) {
    throw new GithubConnectionError(
      "Use a GitHub repository in owner/name form.",
      "repository_invalid",
    );
  }
  return repository.toLowerCase();
}

async function requireOwner(
  client: PoolClient,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const found = await client.query(
    `SELECT 1 FROM workspace_users
      WHERE workspace_id = $1 AND user_id = $2 AND role = 'owner'`,
    [workspaceId, userId],
  );
  if (!found.rows[0]) {
    throw new GithubConnectionError(
      "Only workspace owners can manage GitHub connections.",
      "owner_required",
      403,
    );
  }
}

function headers(accessToken: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "doco-self-hosted",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubJson(
  fetcher: Fetcher,
  url: string,
  accessToken: string,
): Promise<{ value: unknown; response: Response }> {
  const response = await fetcher(url, { headers: headers(accessToken) });
  if (!response.ok) {
    const message =
      response.status === 401 || response.status === 403
        ? "GitHub rejected the token. Grant Metadata, Issues, and Pull requests read access."
        : `GitHub returned ${response.status} while reading the repository.`;
    throw new GithubConnectionError(message, "github_request_failed", 502);
  }
  return { value: await response.json(), response };
}

async function verifyRepository(
  fetcher: Fetcher,
  repository: string,
  accessToken: string,
): Promise<void> {
  const { value } = await githubJson(fetcher, `${API}/repos/${repository}`, accessToken);
  const fullName = (value as { full_name?: unknown })?.full_name;
  if (typeof fullName !== "string" || fullName.toLowerCase() !== repository) {
    throw new GithubConnectionError(
      "GitHub returned a different repository.",
      "repository_mismatch",
      502,
    );
  }
}

async function existingCollection(
  client: PoolClient,
  workspaceId: string,
  templateHandle: string,
): Promise<{ collectionId: string; handle: string } | null> {
  const found = await client.query<{ id: string; handle: string }>(
    `SELECT id, handle FROM collections
      WHERE workspace_id = $1 AND data->>'template_handle' = $2 AND deleted_at IS NULL
      ORDER BY created_at LIMIT 1`,
    [workspaceId, templateHandle],
  );
  const row = found.rows[0];
  return row ? { collectionId: row.id, handle: row.handle } : null;
}

async function ensureCollection(
  client: PoolClient,
  input: {
    workspaceId: string;
    workspaceHandle: string;
    userId: string;
    templateHandle: "github-issues" | "github-pull-requests";
  },
): Promise<{ collectionId: string; handle: string }> {
  return (
    (await existingCollection(client, input.workspaceId, input.templateHandle)) ??
    createCollectionInWorkspace(
      {
        workspaceId: input.workspaceId,
        requestedHandle: `${input.workspaceHandle}-${input.templateHandle}`,
        createdByUserId: input.userId,
        templateHandle: input.templateHandle,
      },
      client,
    )
  );
}

async function summary(client: PoolClient, connectionId: string): Promise<GithubConnectionSummary> {
  const found = await client.query<{
    id: string;
    repository: string;
    issues_handle: string;
    pulls_handle: string;
    active: boolean;
    last_synced_at: Date | string | null;
    last_error: string | null;
  }>(
    `SELECT g.id, g.repository, i.handle AS issues_handle, p.handle AS pulls_handle,
            g.active, g.last_synced_at, g.last_error
       FROM github_connections g
       JOIN collections i ON i.id = g.issues_collection_id
       JOIN collections p ON p.id = g.pull_requests_collection_id
      WHERE g.id = $1`,
    [connectionId],
  );
  const row = found.rows[0];
  if (!row)
    throw new GithubConnectionError("GitHub connection not found.", "connection_not_found", 404);
  return {
    id: row.id,
    repository: row.repository,
    issuesCollectionHandle: row.issues_handle,
    pullRequestsCollectionHandle: row.pulls_handle,
    active: row.active,
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
    lastError: row.last_error,
  };
}

export async function connectGithubRepository(
  client: PoolClient,
  input: {
    workspaceId: string;
    userId: string;
    repository: string;
    accessToken: string;
    encryptionKey: string;
    fetcher?: Fetcher;
  },
): Promise<GithubConnectionSummary> {
  await requireOwner(client, input.workspaceId, input.userId);
  const repository = normalizeRepository(input.repository);
  const accessToken = input.accessToken.trim();
  if (!accessToken) throw new GithubConnectionError("GitHub token is required.", "token_required");
  const fetcher = input.fetcher ?? fetch;
  await verifyRepository(fetcher, repository, accessToken);
  const tokenSealed = sealSecret(accessToken, input.encryptionKey);
  const current = await client.query<ConnectionRow>(
    "SELECT * FROM github_connections WHERE workspace_id = $1",
    [input.workspaceId],
  );
  const existing = current.rows[0];
  if (existing) {
    if (existing.repository !== repository) {
      throw new GithubConnectionError(
        `This workspace is already connected to ${existing.repository}.`,
        "source_already_connected",
        409,
      );
    }
    await client.query(
      `UPDATE github_connections
          SET token_sealed = $2, active = true, last_error = NULL
        WHERE id = $1`,
      [existing.id, tokenSealed],
    );
    return summary(client, existing.id);
  }

  await client.query("BEGIN");
  try {
    const workspace = await client.query<{ handle: string }>(
      "SELECT handle FROM workspaces WHERE id = $1",
      [input.workspaceId],
    );
    const workspaceHandle = workspace.rows[0]?.handle;
    if (!workspaceHandle)
      throw new GithubConnectionError("Workspace not found.", "workspace_not_found", 404);
    const issues = await ensureCollection(client, {
      workspaceId: input.workspaceId,
      workspaceHandle,
      userId: input.userId,
      templateHandle: "github-issues",
    });
    const pulls = await ensureCollection(client, {
      workspaceId: input.workspaceId,
      workspaceHandle,
      userId: input.userId,
      templateHandle: "github-pull-requests",
    });
    const id = `github_${generateUlid()}`;
    await client.query(
      `INSERT INTO github_connections
         (id, workspace_id, repository, token_sealed, issues_collection_id,
          pull_requests_collection_id, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        input.workspaceId,
        repository,
        tokenSealed,
        issues.collectionId,
        pulls.collectionId,
        input.userId,
      ],
    );
    await client.query("COMMIT");
    return summary(client, id);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function listGithubConnections(
  client: PoolClient,
  workspaceId: string,
  userId: string,
): Promise<GithubConnectionSummary[]> {
  await requireOwner(client, workspaceId, userId);
  const found = await client.query<{ id: string }>(
    "SELECT id FROM github_connections WHERE workspace_id = $1 ORDER BY created_at",
    [workspaceId],
  );
  return Promise.all(found.rows.map((row) => summary(client, row.id)));
}

export async function disconnectGithubRepository(
  client: PoolClient,
  input: { connectionId: string; userId: string },
): Promise<void> {
  const connection = await client.query<{ workspace_id: string }>(
    "SELECT workspace_id FROM github_connections WHERE id = $1",
    [input.connectionId],
  );
  const row = connection.rows[0];
  if (!row)
    throw new GithubConnectionError("GitHub connection not found.", "connection_not_found", 404);
  await requireOwner(client, row.workspace_id, input.userId);
  await client.query(
    "UPDATE github_connections SET active = false, token_sealed = NULL WHERE id = $1",
    [input.connectionId],
  );
}

function nextLink(value: string | null): string | null {
  if (!value) return null;
  for (const part of value.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match?.[1]) return match[1];
  }
  return null;
}

async function fetchPages(
  fetcher: Fetcher,
  url: string,
  accessToken: string,
): Promise<GithubItem[]> {
  const items: GithubItem[] = [];
  let next: string | null = url;
  for (let page = 0; next && page < 100; page += 1) {
    const { value, response } = await githubJson(fetcher, next, accessToken);
    if (!Array.isArray(value)) {
      throw new GithubConnectionError(
        "GitHub returned an invalid list.",
        "github_response_invalid",
        502,
      );
    }
    items.push(...(value as GithubItem[]));
    next = nextLink(response.headers.get("link"));
  }
  if (next)
    throw new GithubConnectionError(
      "GitHub pagination exceeded 10,000 items.",
      "github_too_large",
      422,
    );
  return items;
}

function labels(item: GithubItem): string[] {
  return (item.labels ?? [])
    .map((label) => (typeof label === "string" ? label : label.name))
    .filter((label): label is string => Boolean(label));
}

function prose(item: GithubItem): string {
  const title = `#${item.number} ${item.title}`;
  return item.body?.trim() ? `${title}\n\n${item.body.trim()}` : title;
}

function issueFields(item: GithubItem, connection: ConnectionRow): Record<string, unknown> {
  return {
    node_type: "eval",
    collection_id: connection.issues_collection_id,
    lifecycle: item.state === "closed" ? "retired" : "active",
    prose: prose(item),
    kind: "github_issue",
    locator: item.html_url,
    github_repository: connection.repository,
    github_number: item.number,
    github_state: item.state,
    github_author: item.user?.login ?? null,
    github_labels: labels(item),
    github_comments: item.comments ?? 0,
    github_locked: item.locked ?? false,
    github_created_at: item.created_at,
    github_updated_at: item.updated_at,
  };
}

function pullFields(item: GithubItem, connection: ConnectionRow): Record<string, unknown> {
  const lifecycle = item.merged_at ? "active" : item.state === "closed" ? "retired" : "drafting";
  return {
    node_type: "reference",
    collection_id: connection.pull_requests_collection_id,
    lifecycle,
    prose: prose(item),
    locator: item.html_url,
    github_repository: connection.repository,
    github_number: item.number,
    github_state: item.state,
    github_author: item.user?.login ?? null,
    github_labels: labels(item),
    github_draft: item.draft ?? false,
    github_merged_at: item.merged_at ?? null,
    github_head: item.head?.ref ?? null,
    github_base: item.base?.ref ?? null,
    github_created_at: item.created_at,
    github_updated_at: item.updated_at,
  };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(object[key])}`)
    .join(",")}}`;
}

function storedFields(node: StoredNode, collectionId: string): Record<string, unknown> {
  return {
    ...node.extra,
    id: node.id,
    node_type: node.node_type,
    collection_id: collectionId,
    lifecycle: node.lifecycle,
    prose: node.prose,
    ...(node.kind ? { kind: node.kind } : {}),
    ...(node.locator ? { locator: node.locator } : {}),
    created_at: iso(node.created_at),
    created_by: node.created_by,
    updated_at: iso(node.updated_at),
    updated_by: node.updated_by,
  };
}

function sameNode(node: StoredNode, fields: Record<string, unknown>): boolean {
  const desired = nodeRowFromFields(String(fields.node_type), fields);
  return (
    node.node_type === fields.node_type &&
    node.lifecycle === fields.lifecycle &&
    node.prose === fields.prose &&
    node.kind === (fields.kind ?? null) &&
    node.locator === (fields.locator ?? null) &&
    stable(node.extra) === stable(desired.extra)
  );
}

async function importItems(
  client: PoolClient,
  connection: ConnectionRow,
  collectionId: string,
  nodeType: "eval" | "reference",
  actorId: string,
  items: GithubItem[],
  fieldsFor: (item: GithubItem, connection: ConnectionRow) => Record<string, unknown>,
): Promise<{ created: number; updated: number; unchanged: number }> {
  const counts = { created: 0, updated: 0, unchanged: 0 };
  let txId: number | null = null;
  for (const item of items) {
    if (
      !Number.isInteger(item.number) ||
      !item.html_url ||
      !item.title ||
      !item.created_at ||
      !item.updated_at
    ) {
      throw new GithubConnectionError(
        "GitHub returned an incomplete item.",
        "github_response_invalid",
        502,
      );
    }
    const found = await client.query<StoredNode>(
      `SELECT id, node_type, lifecycle, prose, kind, locator, extra,
              created_at, created_by, updated_at, updated_by
         FROM nodes WHERE collection_id = $1 AND locator = $2 LIMIT 1 FOR UPDATE`,
      [collectionId, item.html_url],
    );
    const before = found.rows[0];
    const imported = fieldsFor(item, connection);
    if (before && sameNode(before, imported)) {
      counts.unchanged += 1;
      continue;
    }
    txId ??= await createChangeset(client, {
      collectionId,
      actor: actorId,
      source: "import",
      reason: `Sync GitHub ${connection.repository}`,
      metadata: { integration: "github", repository: connection.repository },
    });
    const timestamp = item.updated_at;
    const fields: Record<string, unknown> = {
      ...imported,
      id: before?.id ?? makeEntityId(nodeType, generateUlid()),
      created_at: before ? iso(before.created_at) : item.created_at,
      created_by: before?.created_by ?? actorId,
      updated_at: timestamp,
      updated_by: actorId,
    };
    await upsertNode(nodeRowFromFields(nodeType, fields), client);
    await appendNodeVersion(client, {
      entityId: String(fields.id),
      entityType: nodeType,
      op: before ? "update" : "create",
      payload: fields,
      txId,
      actor: actorId,
    });
    await appendAuditEventRow(
      {
        event_id: `evt_${generateUlid()}`,
        at: timestamp,
        by_user: actorId,
        collection_id: collectionId,
        workspace_id: connection.workspace_id,
        entity_type: nodeType,
        entity_id: String(fields.id),
        op: before ? "entity.update" : "entity.create",
        before_json: before ? storedFields(before, collectionId) : null,
        after_json: fields,
        reason: `Sync GitHub ${connection.repository}`,
      },
      client,
    );
    counts[before ? "updated" : "created"] += 1;
  }
  return counts;
}

export async function syncGithubConnection(
  client: PoolClient,
  input: { connectionId: string; encryptionKey: string; userId?: string; fetcher?: Fetcher },
): Promise<{ created: number; updated: number; unchanged: number }> {
  const found = await client.query<ConnectionRow>(
    "SELECT * FROM github_connections WHERE id = $1",
    [input.connectionId],
  );
  const connection = found.rows[0];
  if (!connection || !connection.active || !connection.token_sealed) {
    throw new GithubConnectionError("GitHub connection is not active.", "connection_inactive", 409);
  }
  if (input.userId) await requireOwner(client, connection.workspace_id, input.userId);
  const accessToken = openSecret(connection.token_sealed, input.encryptionKey);
  const fetcher = input.fetcher ?? fetch;
  try {
    const [issues, pulls] = await Promise.all([
      fetchPages(
        fetcher,
        `${API}/repos/${connection.repository}/issues?state=all&per_page=100`,
        accessToken,
      ),
      fetchPages(
        fetcher,
        `${API}/repos/${connection.repository}/pulls?state=all&per_page=100`,
        accessToken,
      ),
    ]);
    await client.query("BEGIN");
    try {
      const issueResult = await importItems(
        client,
        connection,
        connection.issues_collection_id,
        "eval",
        connection.created_by_user_id,
        issues.filter((item) => !item.pull_request),
        issueFields,
      );
      const pullResult = await importItems(
        client,
        connection,
        connection.pull_requests_collection_id,
        "reference",
        connection.created_by_user_id,
        pulls,
        pullFields,
      );
      await client.query(
        "UPDATE github_connections SET last_synced_at = now(), last_error = NULL WHERE id = $1",
        [connection.id],
      );
      await client.query("COMMIT");
      return {
        created: issueResult.created + pullResult.created,
        updated: issueResult.updated + pullResult.updated,
        unchanged: issueResult.unchanged + pullResult.unchanged,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } catch (error) {
    await client.query("UPDATE github_connections SET last_error = $2 WHERE id = $1", [
      connection.id,
      error instanceof Error ? error.message.slice(0, 500) : "GitHub sync failed.",
    ]);
    throw error;
  }
}
