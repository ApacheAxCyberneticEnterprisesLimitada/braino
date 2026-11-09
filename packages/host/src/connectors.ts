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

export type ConnectorFetcher = typeof fetch;
const CONNECTOR_PROVIDER_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;
const CONNECTOR_REQUEST_TIMEOUT_MS = 30_000;
const MAX_CONNECTOR_DOCUMENTS = 10_000;
const MAX_CONNECTOR_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_CONNECTOR_TOTAL_BYTES = 128 * 1024 * 1024;

export class ConnectorError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

export interface ConnectorSource {
  id: string;
  name: string;
  config?: Record<string, unknown>;
}

export interface ConnectorDocument {
  externalId: string;
  title: string;
  content: string;
  url: string;
  createdAt?: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface ConnectorAdapter {
  provider: string;
  verify(input: { credential: string; fetcher: ConnectorFetcher }): Promise<ConnectorSource>;
  documents(input: {
    credential: string;
    source: ConnectorSource;
    fetcher: ConnectorFetcher;
  }): AsyncIterable<ConnectorDocument>;
}

export interface ConnectorConnectionSummary {
  id: string;
  provider: string;
  sourceId: string;
  sourceName: string;
  collectionHandle: string;
  active: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
}

interface ConnectionRow {
  id: string;
  workspace_id: string;
  provider: string;
  source_id: string;
  source_name: string;
  credential_sealed: string | null;
  collection_id: string;
  created_by_user_id: string;
  config: Record<string, unknown>;
  active: boolean;
  sync_token: string | null;
  sync_started_at: Date | string | null;
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
    throw new ConnectorError("Only workspace owners can manage connectors.", "owner_required", 403);
  }
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new ConnectorError("The connector returned an invalid timestamp.", "source_invalid", 502);
  }
  return date.toISOString();
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

function providerHandle(provider: string): string {
  if (!CONNECTOR_PROVIDER_PATTERN.test(provider)) {
    throw new ConnectorError("The connector provider identifier is invalid.", "provider_invalid");
  }
  return provider.replaceAll("_", "-");
}

function boundedFetcher(fetcher: ConnectorFetcher): ConnectorFetcher {
  return async (resource, init = {}) => {
    const timeout = AbortSignal.timeout(CONNECTOR_REQUEST_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      return await fetcher(resource, { ...init, signal });
    } catch (error) {
      if (timeout.aborted && !init.signal?.aborted) {
        throw new ConnectorError(
          "The connector provider did not respond within 30 seconds.",
          "connector_timeout",
          504,
        );
      }
      throw error;
    }
  };
}

function documentBytes(document: ConnectorDocument): number {
  if (
    !document.externalId.trim() ||
    !document.title.trim() ||
    !document.content.trim() ||
    !document.url.trim()
  ) {
    throw new ConnectorError(
      "The connector returned an incomplete document.",
      "source_invalid",
      502,
    );
  }
  iso(document.updatedAt);
  if (document.createdAt) iso(document.createdAt);
  return Buffer.byteLength(
    `${document.externalId}\n${document.title}\n${document.content}\n${document.url}\n${stable(document.metadata ?? {})}`,
  );
}

async function collectDocuments(
  documents: AsyncIterable<ConnectorDocument>,
): Promise<ConnectorDocument[]> {
  const collected: ConnectorDocument[] = [];
  const ids = new Set<string>();
  let totalBytes = 0;
  for await (const document of documents) {
    if (collected.length >= MAX_CONNECTOR_DOCUMENTS) {
      throw new ConnectorError(
        "A connector sync cannot exceed 10,000 documents.",
        "source_too_large",
        422,
      );
    }
    if (ids.has(document.externalId)) {
      throw new ConnectorError(
        `The connector returned duplicate document ${document.externalId}.`,
        "source_invalid",
        502,
      );
    }
    const bytes = documentBytes(document);
    if (bytes > MAX_CONNECTOR_DOCUMENT_BYTES) {
      throw new ConnectorError(
        `Connector document ${document.externalId} exceeds 10 MB.`,
        "source_too_large",
        422,
      );
    }
    totalBytes += bytes;
    if (totalBytes > MAX_CONNECTOR_TOTAL_BYTES) {
      throw new ConnectorError(
        "A connector sync cannot exceed 128 MB of document content.",
        "source_too_large",
        422,
      );
    }
    ids.add(document.externalId);
    collected.push(document);
  }
  return collected;
}

async function connectionSummary(
  client: PoolClient,
  connectionId: string,
): Promise<ConnectorConnectionSummary> {
  const found = await client.query<{
    id: string;
    provider: string;
    source_id: string;
    source_name: string;
    collection_handle: string;
    active: boolean;
    last_synced_at: Date | string | null;
    last_error: string | null;
  }>(
    `SELECT s.id, s.provider, s.source_id, s.source_name,
            c.handle AS collection_handle, s.active, s.last_synced_at, s.last_error
       FROM connector_connections s
       JOIN collections c ON c.id = s.collection_id
      WHERE s.id = $1`,
    [connectionId],
  );
  const row = found.rows[0];
  if (!row) throw new ConnectorError("Connector not found.", "connection_not_found", 404);
  return {
    id: row.id,
    provider: row.provider,
    sourceId: row.source_id,
    sourceName: row.source_name,
    collectionHandle: row.collection_handle,
    active: row.active,
    lastSyncedAt: row.last_synced_at ? iso(row.last_synced_at) : null,
    lastError: row.last_error,
  };
}

export async function connectConnector(
  withClient: ClientScope,
  input: {
    workspaceId: string;
    userId: string;
    credential: string;
    encryptionKey: string;
    adapter: ConnectorAdapter;
    fetcher?: ConnectorFetcher;
  },
): Promise<ConnectorConnectionSummary> {
  const provider = providerHandle(input.adapter.provider);
  await withClient((client) => requireOwner(client, input.workspaceId, input.userId));
  const credential = input.credential.trim();
  if (!credential)
    throw new ConnectorError("A connector credential is required.", "credential_required");
  const fetcher = boundedFetcher(input.fetcher ?? fetch);
  const source = await input.adapter.verify({ credential, fetcher });
  if (!source.id.trim() || !source.name.trim()) {
    throw new ConnectorError("The connector returned an invalid source.", "source_invalid", 502);
  }
  return withClient(async (client) => {
    await requireOwner(client, input.workspaceId, input.userId);
    const occupied = await client.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM connector_connections
        WHERE provider = $1 AND source_id = $2 AND workspace_id <> $3`,
      [input.adapter.provider, source.id, input.workspaceId],
    );
    if (occupied.rows[0]) {
      throw new ConnectorError(
        `This ${provider} source is already connected to another workspace.`,
        "source_already_connected",
        409,
      );
    }
    const current = await client.query<ConnectionRow>(
      "SELECT * FROM connector_connections WHERE workspace_id = $1 AND provider = $2",
      [input.workspaceId, input.adapter.provider],
    );
    const existing = current.rows[0];
    const sealed = sealSecret(credential, input.encryptionKey);
    if (existing) {
      if (existing.source_id !== source.id) {
        throw new ConnectorError(
          `Disconnect ${existing.source_name} before connecting another ${provider} source.`,
          "provider_already_connected",
          409,
        );
      }
      await client.query(
        `UPDATE connector_connections
            SET source_name = $2, credential_sealed = $3, config = $4::jsonb,
                active = true, last_error = NULL
          WHERE id = $1`,
        [existing.id, source.name, sealed, JSON.stringify(source.config ?? {})],
      );
      return connectionSummary(client, existing.id);
    }

    await client.query("BEGIN");
    try {
      const workspace = await client.query<{ handle: string }>(
        "SELECT handle FROM workspaces WHERE id = $1",
        [input.workspaceId],
      );
      const workspaceHandle = workspace.rows[0]?.handle;
      if (!workspaceHandle)
        throw new ConnectorError("Workspace not found.", "workspace_not_found", 404);
      const collection = await createCollectionInWorkspace(
        {
          workspaceId: input.workspaceId,
          requestedHandle: `${workspaceHandle}-${provider}`,
          createdByUserId: input.userId,
          visibility: "private",
          templateHandle: "documents",
          goal: `Read-only knowledge synchronized from ${source.name} through the ${provider} connector.`,
        },
        client,
      );
      const id = `connector_${generateUlid()}`;
      await client.query(
        `INSERT INTO connector_connections
           (id, workspace_id, provider, source_id, source_name, credential_sealed,
            collection_id, created_by_user_id, config)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          id,
          input.workspaceId,
          input.adapter.provider,
          source.id,
          source.name,
          sealed,
          collection.collectionId,
          input.userId,
          JSON.stringify(source.config ?? {}),
        ],
      );
      await client.query(
        `UPDATE collections
            SET data = data || jsonb_build_object(
              'connector_id', $2::text,
              'connector_provider', $3::text
            )
          WHERE id = $1`,
        [collection.collectionId, id, input.adapter.provider],
      );
      await client.query("COMMIT");
      return connectionSummary(client, id);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function listConnectorConnections(
  client: PoolClient,
  workspaceId: string,
  userId: string,
): Promise<ConnectorConnectionSummary[]> {
  await requireOwner(client, workspaceId, userId);
  const found = await client.query<{ id: string }>(
    "SELECT id FROM connector_connections WHERE workspace_id = $1 ORDER BY created_at, id",
    [workspaceId],
  );
  return Promise.all(found.rows.map((row) => connectionSummary(client, row.id)));
}

export async function disconnectConnector(
  client: PoolClient,
  input: { connectionId: string; userId: string },
): Promise<void> {
  const found = await client.query<{ workspace_id: string }>(
    "SELECT workspace_id FROM connector_connections WHERE id = $1",
    [input.connectionId],
  );
  const row = found.rows[0];
  if (!row) throw new ConnectorError("Connector not found.", "connection_not_found", 404);
  await requireOwner(client, row.workspace_id, input.userId);
  await client.query(
    `UPDATE connector_connections
        SET active = false, credential_sealed = NULL
      WHERE id = $1`,
    [input.connectionId],
  );
}

function documentFields(
  connection: ConnectionRow,
  document: ConnectorDocument,
): Record<string, unknown> {
  const title = document.title.trim();
  const content = document.content.trim();
  const url = document.url.trim();
  if (!document.externalId.trim() || !title || !content || !url) {
    throw new ConnectorError(
      "The connector returned an incomplete document.",
      "source_invalid",
      502,
    );
  }
  return {
    node_type: "reference",
    collection_id: connection.collection_id,
    lifecycle: "active",
    prose: `${title}\n\n${content}`,
    locator: url,
    connector_provider: connection.provider,
    connector_connection_id: connection.id,
    connector_external_id: document.externalId,
    connector_source_id: connection.source_id,
    connector_source_name: connection.source_name,
    connector_metadata: document.metadata ?? {},
    source_updated_at: iso(document.updatedAt),
  };
}

async function writeDocument(
  client: PoolClient,
  input: {
    connection: ConnectionRow;
    document: ConnectorDocument;
    runId: string;
    txId: number | null;
  },
): Promise<{ state: "created" | "updated" | "unchanged"; txId: number | null }> {
  const mapped = await client.query<StoredNode & { node_id: string }>(
    `SELECT n.id, n.id AS node_id, n.node_type, n.lifecycle, n.prose, n.kind, n.locator,
            n.extra, n.created_at, n.created_by, n.updated_at, n.updated_by
       FROM connector_documents d
       JOIN nodes n ON n.id = d.node_id
      WHERE d.connection_id = $1 AND d.external_id = $2
      FOR UPDATE`,
    [input.connection.id, input.document.externalId],
  );
  const before = mapped.rows[0];
  const desired = documentFields(input.connection, input.document);
  if (before && sameNode(before, desired)) {
    await client.query(
      `UPDATE connector_documents
          SET seen_run_id = $3, last_seen_at = now()
        WHERE connection_id = $1 AND external_id = $2`,
      [input.connection.id, input.document.externalId, input.runId],
    );
    return { state: "unchanged", txId: input.txId };
  }
  const txId =
    input.txId ??
    (await createChangeset(client, {
      collectionId: input.connection.collection_id,
      actor: input.connection.created_by_user_id,
      source: "import",
      reason: `Sync ${input.connection.source_name}`,
      metadata: { connector: input.connection.provider, source_id: input.connection.source_id },
    }));
  const timestamp = iso(input.document.updatedAt);
  const fields: Record<string, unknown> = {
    ...desired,
    id: before?.id ?? makeEntityId("reference", generateUlid()),
    created_at: before
      ? iso(before.created_at)
      : iso(input.document.createdAt ?? input.document.updatedAt),
    created_by: before?.created_by ?? input.connection.created_by_user_id,
    updated_at: timestamp,
    updated_by: input.connection.created_by_user_id,
  };
  await upsertNode(nodeRowFromFields("reference", fields), client);
  await appendNodeVersion(client, {
    entityId: String(fields.id),
    entityType: "reference",
    op: before ? "update" : "create",
    payload: fields,
    txId,
    actor: input.connection.created_by_user_id,
  });
  await appendAuditEventRow(
    {
      event_id: `evt_${generateUlid()}`,
      at: timestamp,
      by_user: input.connection.created_by_user_id,
      collection_id: input.connection.collection_id,
      workspace_id: input.connection.workspace_id,
      entity_type: "reference",
      entity_id: String(fields.id),
      op: before ? "entity.update" : "entity.create",
      before_json: before ? storedFields(before, input.connection.collection_id) : null,
      after_json: fields,
      reason: `Sync ${input.connection.source_name}`,
    },
    client,
  );
  await client.query(
    `INSERT INTO connector_documents (connection_id, external_id, node_id, seen_run_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (connection_id, external_id) DO UPDATE
       SET node_id = EXCLUDED.node_id, seen_run_id = EXCLUDED.seen_run_id, last_seen_at = now()`,
    [input.connection.id, input.document.externalId, fields.id, input.runId],
  );
  return { state: before ? "updated" : "created", txId };
}

async function retireMissing(
  client: PoolClient,
  input: { connection: ConnectionRow; runId: string; txId: number | null },
): Promise<{ retired: number; txId: number | null }> {
  const missing = await client.query<StoredNode>(
    `SELECT n.id, n.node_type, n.lifecycle, n.prose, n.kind, n.locator,
            n.extra, n.created_at, n.created_by, n.updated_at, n.updated_by
       FROM connector_documents d
       JOIN nodes n ON n.id = d.node_id
      WHERE d.connection_id = $1 AND d.seen_run_id <> $2 AND n.lifecycle <> 'retired'
      FOR UPDATE`,
    [input.connection.id, input.runId],
  );
  let txId = input.txId;
  for (const before of missing.rows) {
    txId ??= await createChangeset(client, {
      collectionId: input.connection.collection_id,
      actor: input.connection.created_by_user_id,
      source: "import",
      reason: `Sync ${input.connection.source_name}`,
      metadata: { connector: input.connection.provider, source_id: input.connection.source_id },
    });
    const timestamp = new Date().toISOString();
    const fields = {
      ...storedFields(before, input.connection.collection_id),
      lifecycle: "retired",
      updated_at: timestamp,
      updated_by: input.connection.created_by_user_id,
    };
    await upsertNode(nodeRowFromFields("reference", fields), client);
    await appendNodeVersion(client, {
      entityId: before.id,
      entityType: "reference",
      op: "retire",
      payload: fields,
      txId,
      actor: input.connection.created_by_user_id,
    });
    await appendAuditEventRow(
      {
        event_id: `evt_${generateUlid()}`,
        at: timestamp,
        by_user: input.connection.created_by_user_id,
        collection_id: input.connection.collection_id,
        workspace_id: input.connection.workspace_id,
        entity_type: "reference",
        entity_id: before.id,
        op: "lifecycle.transition",
        before_json: storedFields(before, input.connection.collection_id),
        after_json: fields,
        reason: `Removed from ${input.connection.source_name}`,
      },
      client,
    );
  }
  return { retired: missing.rows.length, txId };
}

export async function syncConnectorConnection(
  withClient: ClientScope,
  input: {
    connectionId: string;
    encryptionKey: string;
    adapter: ConnectorAdapter;
    userId?: string;
    fetcher?: ConnectorFetcher;
  },
): Promise<{ created: number; updated: number; retired: number; unchanged: number }> {
  providerHandle(input.adapter.provider);
  const syncToken = generateUlid();
  const connection = await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const found = await client.query<ConnectionRow>(
        "SELECT * FROM connector_connections WHERE id = $1 FOR UPDATE",
        [input.connectionId],
      );
      const row = found.rows[0];
      if (!row || !row.active || !row.credential_sealed) {
        throw new ConnectorError("Connector is not active.", "connection_inactive", 409);
      }
      if (row.provider !== input.adapter.provider) {
        throw new ConnectorError(
          "The connector adapter does not match this connection.",
          "adapter_mismatch",
        );
      }
      if (input.userId) await requireOwner(client, row.workspace_id, input.userId);
      const claimed = await client.query<ConnectionRow>(
        `UPDATE connector_connections
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
      if (!active) {
        throw new ConnectorError(
          "This connector already has a sync in progress.",
          "sync_in_progress",
          409,
        );
      }
      await client.query("COMMIT");
      return active as ConnectionRow & { credential_sealed: string };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
  try {
    const credential = openSecret(connection.credential_sealed, input.encryptionKey);
    const fetcher = boundedFetcher(input.fetcher ?? fetch);
    const documents = await collectDocuments(
      input.adapter.documents({
        credential,
        source: {
          id: connection.source_id,
          name: connection.source_name,
          config: connection.config,
        },
        fetcher,
      }),
    );
    return await withClient(async (client) => {
      const runId = generateUlid();
      const counts = { created: 0, updated: 0, retired: 0, unchanged: 0 };
      let txId: number | null = null;
      await client.query("BEGIN");
      try {
        const locked = await client.query<ConnectionRow>(
          "SELECT * FROM connector_connections WHERE id = $1 FOR UPDATE",
          [connection.id],
        );
        const current = locked.rows[0];
        if (!current || !current.active || !current.credential_sealed) {
          throw new ConnectorError("Connector is not active.", "connection_inactive", 409);
        }
        if (current.sync_token !== syncToken) {
          throw new ConnectorError(
            "This connector sync was superseded by a newer run.",
            "sync_superseded",
            409,
          );
        }
        for (const document of documents) {
          const written = await writeDocument(client, {
            connection: current,
            document,
            runId,
            txId,
          });
          txId = written.txId;
          counts[written.state] += 1;
        }
        const retired = await retireMissing(client, { connection: current, runId, txId });
        counts.retired = retired.retired;
        await client.query(
          `UPDATE connector_connections
              SET last_synced_at = now(), last_error = NULL,
                  sync_token = NULL, sync_started_at = NULL
            WHERE id = $1 AND sync_token = $2`,
          [current.id, syncToken],
        );
        await client.query("COMMIT");
        return counts;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  } catch (error) {
    await withClient(async (client) => {
      await client.query(
        `UPDATE connector_connections
            SET last_error = $2, sync_token = NULL, sync_started_at = NULL
          WHERE id = $1 AND sync_token = $3`,
        [
          connection.id,
          error instanceof Error ? error.message.slice(0, 500) : "Connector sync failed.",
          syncToken,
        ],
      );
    });
    throw error;
  }
}
