import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type PoolClient,
  appendAuditEventRow,
  appendNodeVersion,
  createChangeset,
  nodeRowFromFields,
  upsertNode,
} from "@doco/db";
import { generateUlid, makeEntityId } from "@doco/shared";
import type { ClientScope } from "./client-scope.js";
import { createCollectionInWorkspace } from "./host.js";
import { openSecret, sealSecret } from "./secret-box.js";

const API = "https://api.github.com";
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_REQUEST_TIMEOUT_MS = 30_000;
const MAX_GITHUB_PAGE_BYTES = 10 * 1024 * 1024;
const MAX_GITHUB_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const MAX_GITHUB_ITEMS = 10_000;

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
  webhookConfigured: boolean;
  webhookUrl: string | null;
  webhookLastDeliveryAt: string | null;
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
  webhook_id: string | number | null;
  webhook_secret_sealed: string | null;
  webhook_url: string | null;
  sync_token: string | null;
  sync_started_at: Date | string | null;
}

interface ClaimedConnection {
  connection: ConnectionRow & { token_sealed: string };
  syncToken: string;
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

async function claimGithubOperation(
  withClient: ClientScope,
  input: { connectionId: string; userId?: string },
): Promise<ClaimedConnection> {
  const syncToken = generateUlid();
  const connection = await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const found = await client.query<ConnectionRow>(
        "SELECT * FROM github_connections WHERE id = $1 FOR UPDATE",
        [input.connectionId],
      );
      const row = found.rows[0];
      if (!row || !row.active || !row.token_sealed) {
        throw new GithubConnectionError(
          "GitHub connection is not active.",
          "connection_inactive",
          409,
        );
      }
      if (input.userId) await requireOwner(client, row.workspace_id, input.userId);
      const claimed = await client.query<ConnectionRow>(
        `UPDATE github_connections
            SET sync_token = $2, sync_started_at = now()
          WHERE id = $1
            AND (
              sync_token IS NULL OR sync_started_at IS NULL
              OR sync_started_at < now() - interval '30 minutes'
            )
        RETURNING *`,
        [row.id, syncToken],
      );
      const active = claimed.rows[0];
      if (!active?.token_sealed) {
        throw new GithubConnectionError(
          "This GitHub connection already has an operation in progress.",
          "sync_in_progress",
          409,
        );
      }
      await client.query("COMMIT");
      return active as ConnectionRow & { token_sealed: string };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
  return { connection, syncToken };
}

async function failGithubOperation(
  withClient: ClientScope,
  claimed: ClaimedConnection,
  error: unknown,
): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `UPDATE github_connections
          SET last_error = $2, sync_token = NULL, sync_started_at = NULL
        WHERE id = $1 AND sync_token = $3`,
      [
        claimed.connection.id,
        error instanceof Error ? error.message.slice(0, 500) : "GitHub operation failed.",
        claimed.syncToken,
      ],
    );
  });
}

function headers(accessToken: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "doco-self-hosted",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubFetch(fetcher: Fetcher, url: string, init: RequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
  try {
    return await fetcher(url, { ...init, signal: timeout });
  } catch (error) {
    if (timeout.aborted) {
      throw new GithubConnectionError(
        "GitHub did not respond within 30 seconds.",
        "github_timeout",
        504,
      );
    }
    throw error;
  }
}

async function githubJson(
  fetcher: Fetcher,
  url: string,
  accessToken: string,
): Promise<{ value: unknown; response: Response; bytes: number }> {
  const response = await githubFetch(fetcher, url, { headers: headers(accessToken) });
  if (!response.ok) {
    const message =
      response.status === 401 || response.status === 403
        ? "GitHub rejected the token. Grant Metadata, Issues, and Pull requests read access."
        : `GitHub returned ${response.status} while reading the repository.`;
    throw new GithubConnectionError(message, "github_request_failed", 502);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_GITHUB_PAGE_BYTES) {
    await response.body?.cancel();
    throw new GithubConnectionError(
      "GitHub returned a page larger than 10 MB.",
      "github_too_large",
      422,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new GithubConnectionError(
      "GitHub returned an unreadable response.",
      "github_response_invalid",
      502,
    );
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > MAX_GITHUB_PAGE_BYTES) {
      await reader.cancel();
      throw new GithubConnectionError(
        "GitHub returned a page larger than 10 MB.",
        "github_too_large",
        422,
      );
    }
    chunks.push(part.value);
  }
  try {
    const value = JSON.parse(
      Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        bytes,
      ).toString(),
    );
    return { value, response, bytes };
  } catch {
    throw new GithubConnectionError(
      "GitHub returned invalid JSON.",
      "github_response_invalid",
      502,
    );
  }
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
    webhook_id: string | number | null;
    webhook_url: string | null;
    webhook_last_delivery_at: Date | string | null;
  }>(
    `SELECT g.id, g.repository, i.handle AS issues_handle, p.handle AS pulls_handle,
            g.active, g.last_synced_at, g.last_error, g.webhook_id, g.webhook_url,
            g.webhook_last_delivery_at
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
    webhookConfigured: row.webhook_id !== null && Boolean(row.webhook_url),
    webhookUrl: row.webhook_url,
    webhookLastDeliveryAt: row.webhook_last_delivery_at
      ? new Date(row.webhook_last_delivery_at).toISOString()
      : null,
  };
}

async function githubMutation(
  fetcher: Fetcher,
  url: string,
  accessToken: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: Record<string, unknown>,
  operation: "configure" | "delete" = "configure",
): Promise<unknown> {
  const response = await githubFetch(fetcher, url, {
    method,
    headers: { ...headers(accessToken), "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (operation === "delete" && response.status === 404) return null;
  if (!response.ok) {
    if (operation === "delete") {
      throw new GithubConnectionError(
        response.status === 401 || response.status === 403
          ? "GitHub rejected webhook deletion. Keep Webhooks repository write access until disconnect completes."
          : `GitHub returned ${response.status} while deleting the repository webhook.`,
        "github_webhook_delete_failed",
        502,
      );
    }
    const message =
      response.status === 401 || response.status === 403
        ? "GitHub rejected webhook setup. Grant the token Webhooks repository write access."
        : `GitHub returned ${response.status} while configuring automatic sync.`;
    throw new GithubConnectionError(message, "github_webhook_setup_failed", 502);
  }
  if (response.status === 204) return null;
  return response.json();
}

function githubWebhookUrl(publicHost: string, connectionId: string): string {
  let url: URL;
  try {
    url = new URL(publicHost);
  } catch {
    throw new GithubConnectionError(
      "DOCO_PUBLIC_HOST must be a valid HTTPS URL before automatic GitHub sync can be enabled.",
      "public_host_invalid",
    );
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new GithubConnectionError(
      "DOCO_PUBLIC_HOST must be a public HTTPS URL before automatic GitHub sync can be enabled.",
      "public_host_invalid",
    );
  }
  return `${url.origin}/api/v1/github/webhooks/${connectionId}`;
}

/** Register or rotate the repository webhook that turns GitHub events into a full, idempotent sync. */
export async function configureGithubWebhook(
  withClient: ClientScope,
  input: {
    connectionId: string;
    userId: string;
    publicHost: string;
    encryptionKey: string;
    fetcher?: Fetcher;
  },
): Promise<GithubConnectionSummary> {
  const webhookUrl = githubWebhookUrl(input.publicHost, input.connectionId);
  const webhookSecret = randomBytes(32).toString("base64url");
  const secretSealed = sealSecret(webhookSecret, input.encryptionKey);
  const claimed = await claimGithubOperation(withClient, {
    connectionId: input.connectionId,
    userId: input.userId,
  });
  try {
    const accessToken = openSecret(claimed.connection.token_sealed, input.encryptionKey);
    await withClient(async (client) => {
      const saved = await client.query(
        `UPDATE github_connections
            SET webhook_secret_sealed = $2, webhook_url = $3
          WHERE id = $1 AND sync_token = $4
        RETURNING id`,
        [claimed.connection.id, secretSealed, webhookUrl, claimed.syncToken],
      );
      if (!saved.rows[0]) {
        throw new GithubConnectionError(
          "This GitHub operation no longer owns the connection lease.",
          "sync_lease_lost",
          409,
        );
      }
    });
    const body = {
      name: "web",
      config: {
        url: webhookUrl,
        content_type: "json",
        secret: webhookSecret,
        insecure_ssl: "0",
      },
      events: ["issues", "pull_request"],
      active: true,
    };
    const remote = (await githubMutation(
      input.fetcher ?? fetch,
      claimed.connection.webhook_id
        ? `${API}/repos/${claimed.connection.repository}/hooks/${claimed.connection.webhook_id}`
        : `${API}/repos/${claimed.connection.repository}/hooks`,
      accessToken,
      claimed.connection.webhook_id ? "PATCH" : "POST",
      body,
    )) as { id?: unknown } | null;
    const webhookId = claimed.connection.webhook_id ?? remote?.id;
    if (typeof webhookId !== "number" && typeof webhookId !== "string") {
      throw new GithubConnectionError(
        "GitHub returned an invalid webhook identity.",
        "github_response_invalid",
        502,
      );
    }
    return withClient(async (client) => {
      const saved = await client.query(
        `UPDATE github_connections
            SET webhook_id = $2, webhook_created_at = coalesce(webhook_created_at, now()),
                last_error = NULL, sync_token = NULL, sync_started_at = NULL
          WHERE id = $1 AND sync_token = $3
        RETURNING id`,
        [claimed.connection.id, webhookId, claimed.syncToken],
      );
      if (!saved.rows[0]) {
        throw new GithubConnectionError(
          "This GitHub operation no longer owns the connection lease.",
          "sync_lease_lost",
          409,
        );
      }
      return summary(client, claimed.connection.id);
    });
  } catch (error) {
    await withClient((client) =>
      client.query(
        `UPDATE github_connections
            SET webhook_secret_sealed = $2, webhook_url = $3, last_error = $4,
                sync_token = NULL, sync_started_at = NULL
          WHERE id = $1 AND sync_token = $5`,
        [
          claimed.connection.id,
          claimed.connection.webhook_secret_sealed,
          claimed.connection.webhook_url,
          error instanceof Error ? error.message.slice(0, 500) : "GitHub webhook setup failed.",
          claimed.syncToken,
        ],
      ),
    );
    throw error;
  }
}

export interface GithubWebhookDeliveryResult {
  event: string;
  synced: boolean;
  replayed: boolean;
  created: number;
  updated: number;
  unchanged: number;
}

function verifyGithubSignature(body: string, signature: string, secret: string): void {
  const expected = `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
  const actualBytes = Buffer.from(signature, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new GithubConnectionError(
      "GitHub webhook signature is invalid.",
      "signature_invalid",
      401,
    );
  }
}

/** Validate, deduplicate, and apply one signed GitHub delivery. */
export async function deliverGithubWebhook(
  withClient: ClientScope,
  input: {
    connectionId: string;
    deliveryId: string;
    event: string;
    signature: string;
    body: string;
    encryptionKey: string;
    fetcher?: Fetcher;
  },
): Promise<GithubWebhookDeliveryResult> {
  const deliveryId = input.deliveryId.trim().slice(0, 200);
  const event = input.event.trim().slice(0, 100);
  if (!deliveryId || !event) {
    throw new GithubConnectionError("GitHub delivery headers are required.", "headers_required");
  }
  const reservation = await withClient(async (client) => {
    const found = await client.query<ConnectionRow>(
      "SELECT * FROM github_connections WHERE id = $1",
      [input.connectionId],
    );
    const connection = found.rows[0];
    if (!connection || !connection.active || !connection.webhook_secret_sealed) {
      throw new GithubConnectionError("GitHub webhook is not active.", "webhook_inactive", 404);
    }
    const webhookSecret = openSecret(connection.webhook_secret_sealed, input.encryptionKey);
    verifyGithubSignature(input.body, input.signature.trim(), webhookSecret);
    let payload: unknown;
    try {
      payload = JSON.parse(input.body);
    } catch {
      throw new GithubConnectionError("GitHub webhook payload is invalid.", "payload_invalid");
    }
    const repository =
      payload && typeof payload === "object"
        ? (payload as { repository?: { full_name?: unknown } }).repository?.full_name
        : null;
    if (typeof repository !== "string" || repository.toLowerCase() !== connection.repository) {
      throw new GithubConnectionError(
        "GitHub webhook repository does not match this connection.",
        "repository_mismatch",
        403,
      );
    }
    const reserved = await client.query(
      `INSERT INTO github_webhook_deliveries (connection_id, delivery_id, event, status)
       VALUES ($1, $2, $3, 'processing')
       ON CONFLICT DO NOTHING
       RETURNING delivery_id`,
      [connection.id, deliveryId, event],
    );
    if (!reserved.rows[0]) {
      const prior = await client.query<{
        status: string;
        response: GithubWebhookDeliveryResult | null;
      }>(
        `SELECT status, response FROM github_webhook_deliveries
          WHERE connection_id = $1 AND delivery_id = $2`,
        [connection.id, deliveryId],
      );
      if (prior.rows[0]?.status === "completed" && prior.rows[0].response) {
        return { replay: { ...prior.rows[0].response, replayed: true } };
      }
      throw new GithubConnectionError(
        "This GitHub delivery is already processing.",
        "delivery_in_progress",
        409,
      );
    }
    return { connectionId: connection.id };
  });
  if ("replay" in reservation) return reservation.replay;
  try {
    const supported = event === "issues" || event === "pull_request";
    const synced = supported
      ? await syncGithubConnection(withClient, {
          connectionId: reservation.connectionId,
          encryptionKey: input.encryptionKey,
          ...(input.fetcher ? { fetcher: input.fetcher } : {}),
        })
      : { created: 0, updated: 0, unchanged: 0 };
    const result: GithubWebhookDeliveryResult = {
      event,
      synced: supported,
      replayed: false,
      ...synced,
    };
    await withClient(async (client) => {
      await client.query(
        `UPDATE github_webhook_deliveries
            SET status = 'completed', response = $3::jsonb, completed_at = now()
          WHERE connection_id = $1 AND delivery_id = $2`,
        [reservation.connectionId, deliveryId, JSON.stringify(result)],
      );
      await client.query(
        "UPDATE github_connections SET webhook_last_delivery_at = now() WHERE id = $1",
        [reservation.connectionId],
      );
    });
    return result;
  } catch (error) {
    await withClient((client) =>
      client.query(
        `DELETE FROM github_webhook_deliveries
          WHERE connection_id = $1 AND delivery_id = $2 AND status = 'processing'`,
        [reservation.connectionId, deliveryId],
      ),
    );
    throw error;
  }
}

export async function connectGithubRepository(
  withClient: ClientScope,
  input: {
    workspaceId: string;
    userId: string;
    repository: string;
    accessToken: string;
    encryptionKey: string;
    fetcher?: Fetcher;
  },
): Promise<GithubConnectionSummary> {
  await withClient((client) => requireOwner(client, input.workspaceId, input.userId));
  const repository = normalizeRepository(input.repository);
  const accessToken = input.accessToken.trim();
  if (!accessToken) throw new GithubConnectionError("GitHub token is required.", "token_required");
  const fetcher = input.fetcher ?? fetch;
  await verifyRepository(fetcher, repository, accessToken);
  const tokenSealed = sealSecret(accessToken, input.encryptionKey);
  return withClient(async (client) => {
    await requireOwner(client, input.workspaceId, input.userId);
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
  });
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
  withClient: ClientScope,
  input: {
    connectionId: string;
    userId: string;
    encryptionKey: string;
    fetcher?: Fetcher;
  },
): Promise<void> {
  const claimed = await claimGithubOperation(withClient, {
    connectionId: input.connectionId,
    userId: input.userId,
  });
  try {
    if (claimed.connection.webhook_id !== null) {
      await githubMutation(
        input.fetcher ?? fetch,
        `${API}/repos/${claimed.connection.repository}/hooks/${claimed.connection.webhook_id}`,
        openSecret(claimed.connection.token_sealed, input.encryptionKey),
        "DELETE",
        undefined,
        "delete",
      );
    }
    await withClient(async (client) => {
      const disconnected = await client.query(
        `UPDATE github_connections
            SET active = false, token_sealed = NULL, webhook_id = NULL,
                webhook_secret_sealed = NULL, webhook_url = NULL, last_error = NULL,
                sync_token = NULL, sync_started_at = NULL
          WHERE id = $1 AND sync_token = $2
        RETURNING id`,
        [claimed.connection.id, claimed.syncToken],
      );
      if (!disconnected.rows[0]) {
        throw new GithubConnectionError(
          "This GitHub operation no longer owns the connection lease.",
          "sync_lease_lost",
          409,
        );
      }
    });
  } catch (error) {
    await failGithubOperation(withClient, claimed, error);
    throw error;
  }
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
  let bytes = 0;
  let next: string | null = url;
  for (let page = 0; next && page < 100; page += 1) {
    const pageResult = await githubJson(fetcher, next, accessToken);
    const { value, response } = pageResult;
    if (!Array.isArray(value)) {
      throw new GithubConnectionError(
        "GitHub returned an invalid list.",
        "github_response_invalid",
        502,
      );
    }
    bytes += pageResult.bytes;
    if (items.length + value.length > MAX_GITHUB_ITEMS || bytes > MAX_GITHUB_SNAPSHOT_BYTES) {
      throw new GithubConnectionError(
        "GitHub snapshot exceeded 10,000 items or 128 MB.",
        "github_too_large",
        422,
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
  withClient: ClientScope,
  input: { connectionId: string; encryptionKey: string; userId?: string; fetcher?: Fetcher },
): Promise<{ created: number; updated: number; unchanged: number }> {
  const claimed = await claimGithubOperation(withClient, {
    connectionId: input.connectionId,
    ...(input.userId ? { userId: input.userId } : {}),
  });
  try {
    const accessToken = openSecret(claimed.connection.token_sealed, input.encryptionKey);
    const fetcher = input.fetcher ?? fetch;
    const [issues, pulls] = await Promise.all([
      fetchPages(
        fetcher,
        `${API}/repos/${claimed.connection.repository}/issues?state=all&per_page=100`,
        accessToken,
      ),
      fetchPages(
        fetcher,
        `${API}/repos/${claimed.connection.repository}/pulls?state=all&per_page=100`,
        accessToken,
      ),
    ]);
    return await withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const locked = await client.query<ConnectionRow>(
          "SELECT * FROM github_connections WHERE id = $1 FOR UPDATE",
          [claimed.connection.id],
        );
        const current = locked.rows[0];
        if (!current || !current.active || !current.token_sealed) {
          throw new GithubConnectionError(
            "GitHub connection is not active.",
            "connection_inactive",
            409,
          );
        }
        if (current.sync_token !== claimed.syncToken) {
          throw new GithubConnectionError(
            "This GitHub operation was superseded by a newer run.",
            "sync_superseded",
            409,
          );
        }
        const issueResult = await importItems(
          client,
          current,
          current.issues_collection_id,
          "eval",
          current.created_by_user_id,
          issues.filter((item) => !item.pull_request),
          issueFields,
        );
        const pullResult = await importItems(
          client,
          current,
          current.pull_requests_collection_id,
          "reference",
          current.created_by_user_id,
          pulls,
          pullFields,
        );
        await client.query(
          `UPDATE github_connections
              SET last_synced_at = now(), last_error = NULL,
                  sync_token = NULL, sync_started_at = NULL
            WHERE id = $1 AND sync_token = $2`,
          [current.id, claimed.syncToken],
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
    });
  } catch (error) {
    await failGithubOperation(withClient, claimed, error);
    throw error;
  }
}
