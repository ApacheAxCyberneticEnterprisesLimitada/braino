import { createHash } from "node:crypto";
import type { QueryClient } from "./embeddings.js";

const SNAPSHOT_FORMAT = "doco-retrieval-snapshot" as const;
const SNAPSHOT_VERSION = 1 as const;
const INERT_NOTION_TOKEN = "snapshot:no-credential";

type Scalar = string | number | boolean | null;
type SnapshotValue = Scalar | SnapshotValue[] | { [key: string]: SnapshotValue };
export type SnapshotRow = Record<string, SnapshotValue>;

const TABLE_NAMES = [
  "workspaces",
  "docos",
  "policies",
  "nodes",
  "edges",
  "node_ranks",
  "entity_fts_nodes",
  "node_touches",
  "group_chat_installations",
  "group_chat_mirrors",
  "group_chat_channels",
  "group_chat_members",
  "group_chat_messages",
  "notion_mirrors",
  "notion_pages",
  "notion_links",
  "notion_users",
  "code_files",
  "embeddings",
] as const;

export type SnapshotTableName = (typeof TABLE_NAMES)[number];
export type RetrievalSnapshotTables = Record<SnapshotTableName, SnapshotRow[]>;

export interface RetrievalSnapshotManifest {
  format: typeof SNAPSHOT_FORMAT;
  version: typeof SNAPSHOT_VERSION;
  exportedAt: string;
  appRevision: string | null;
  postgresVersion: string;
  vectorExtensionVersion: string | null;
  docoId: string;
  docoHandle: string;
  workspaceId: string;
  modelIds: string[];
  rowCounts: Record<SnapshotTableName, number>;
  /** SHA-256 of the canonical retrieval corpus, excluding runtime metadata. */
  digest: string;
  /** Production knowledge is intentionally present even though credentials are not. */
  containsProductionContent: true;
  credentialsIncluded: false;
}

export interface RetrievalSnapshot {
  manifest: RetrievalSnapshotManifest;
  tables: RetrievalSnapshotTables;
}

export interface ExportRetrievalSnapshotOptions {
  appRevision?: string | null;
  exportedAt?: string;
}

export interface RestoreRetrievalSnapshotResult {
  docoId: string;
  digest: string;
  rowCounts: Record<SnapshotTableName, number>;
}

interface TableSpec {
  name: SnapshotTableName;
  columns: readonly string[];
  jsonColumns?: readonly string[];
  casts?: Readonly<Record<string, string>>;
  select: (docoId: string, workspaceId: string) => { sql: string; params: unknown[] };
}

const forDoco =
  (table: string, columns: readonly string[], orderBy: string) => (docoId: string) => ({
    sql: `SELECT ${columns.join(", ")} FROM ${table} WHERE doco_id = $1 ORDER BY ${orderBy}`,
    params: [docoId],
  });

const TABLE_SPECS: readonly TableSpec[] = [
  {
    name: "workspaces",
    columns: [
      "id",
      "handle",
      "name",
      "constitution",
      "created_at",
      "updated_at",
      "digest_sent_at",
      "personal_user_id",
    ],
    select: (_docoId, workspaceId) => ({
      sql: `SELECT id, handle, name, constitution, created_at, updated_at, digest_sent_at,
                   NULL::text AS personal_user_id
              FROM workspaces WHERE id = $1`,
      params: [workspaceId],
    }),
  },
  {
    name: "docos",
    columns: [
      "id",
      "handle",
      "owner_id",
      "workspace_id",
      "visibility",
      "default_node_lifecycle",
      "goal",
      "data",
      "created_at",
      "updated_at",
      "deleted_at",
      "latest_activity_at",
    ],
    jsonColumns: ["data"],
    casts: { data: "jsonb" },
    select: (docoId) => ({
      sql: `SELECT id, handle, owner_id, workspace_id, visibility, default_node_lifecycle, goal,
                   '{}'::jsonb AS data, created_at, updated_at, deleted_at, latest_activity_at
              FROM docos WHERE id = $1`,
      params: [docoId],
    }),
  },
  {
    name: "policies",
    columns: [
      "id",
      "doco_id",
      "kind",
      "lifecycle",
      "data",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
    ],
    jsonColumns: ["data"],
    casts: { data: "jsonb" },
    select: forDoco(
      "policies",
      [
        "id",
        "doco_id",
        "kind",
        "lifecycle",
        "data",
        "created_at",
        "created_by",
        "updated_at",
        "updated_by",
      ],
      "id",
    ),
  },
  {
    name: "nodes",
    columns: [
      "id",
      "doco_id",
      "node_type",
      "lifecycle",
      "prose",
      "proposer_id",
      "kind",
      "locator",
      "extra",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
    ],
    jsonColumns: ["extra"],
    casts: { extra: "jsonb" },
    select: (docoId) => ({
      sql: `SELECT id, doco_id, node_type, lifecycle, prose, NULL::text AS proposer_id,
                   kind, locator, extra, created_at, created_by, updated_at, updated_by
              FROM nodes WHERE doco_id = $1 ORDER BY id`,
      params: [docoId],
    }),
  },
  {
    name: "edges",
    columns: [
      "id",
      "doco_id",
      "edge_type",
      "from_id",
      "from_node_type",
      "to_id",
      "to_node_type",
      "label",
      "condition",
      "kind",
      "lifecycle",
      "origin",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "retired_at",
    ],
    select: forDoco(
      "edges",
      [
        "id",
        "doco_id",
        "edge_type",
        "from_id",
        "from_node_type",
        "to_id",
        "to_node_type",
        "label",
        "condition",
        "kind",
        "lifecycle",
        "origin",
        "created_at",
        "created_by",
        "updated_at",
        "updated_by",
        "retired_at",
      ],
      "id",
    ),
  },
  {
    name: "node_ranks",
    columns: ["node_id", "rank"],
    select: (docoId) => ({
      sql: `SELECT r.node_id, r.rank
              FROM node_ranks r JOIN nodes n ON n.id = r.node_id
             WHERE n.doco_id = $1 ORDER BY r.node_id`,
      params: [docoId],
    }),
  },
  {
    name: "entity_fts_nodes",
    columns: ["entity_id", "doco_id", "node_type", "summary", "body"],
    select: forDoco(
      "entity_fts_nodes",
      ["entity_id", "doco_id", "node_type", "summary", "body"],
      "entity_id",
    ),
  },
  {
    name: "node_touches",
    columns: ["node_id", "doco_id", "kind", "value"],
    select: forDoco(
      "node_touches",
      ["node_id", "doco_id", "kind", "value"],
      "node_id, kind, value",
    ),
  },
  {
    name: "group_chat_installations",
    columns: [
      "id",
      "provider",
      "workspace_id",
      "workspace_name",
      "bot_user_id",
      "bot_access_token",
      "bot_scope",
      "installed_by_chat_user_id",
      "installed_by_user_id",
      "doco_workspace_id",
      "data",
      "created_at",
      "updated_at",
    ],
    jsonColumns: ["data"],
    casts: { bot_scope: "text[]", data: "jsonb" },
    select: (docoId) => ({
      sql: `SELECT i.id, i.provider, i.workspace_id, i.workspace_name, i.bot_user_id,
                   NULL::text AS bot_access_token, i.bot_scope, i.installed_by_chat_user_id,
                   NULL::text AS installed_by_user_id, i.doco_workspace_id,
                   '{}'::jsonb AS data, i.created_at, i.updated_at
              FROM group_chat_installations i
              JOIN group_chat_mirrors m ON m.installation_id = i.id
             WHERE m.doco_id = $1 ORDER BY i.id`,
      params: [docoId],
    }),
  },
  {
    name: "group_chat_mirrors",
    columns: [
      "doco_id",
      "installation_id",
      "team_domain",
      "history_since",
      "consented_by",
      "consented_at",
      "channels_synced_at",
      "history_next_at",
      "replies_next_at",
      "created_at",
    ],
    select: (docoId) => ({
      sql: `SELECT doco_id, installation_id, team_domain, history_since,
                   NULL::text AS consented_by, consented_at, channels_synced_at,
                   history_next_at, replies_next_at, created_at
              FROM group_chat_mirrors WHERE doco_id = $1`,
      params: [docoId],
    }),
  },
  {
    name: "group_chat_channels",
    columns: [
      "doco_id",
      "channel_id",
      "name",
      "topic",
      "purpose",
      "archived",
      "excluded",
      "joined_at",
      "history_cursor",
      "history_oldest_ts",
      "history_done_at",
      "created_at",
    ],
    select: forDoco(
      "group_chat_channels",
      [
        "doco_id",
        "channel_id",
        "name",
        "topic",
        "purpose",
        "archived",
        "excluded",
        "joined_at",
        "history_cursor",
        "history_oldest_ts",
        "history_done_at",
        "created_at",
      ],
      "channel_id",
    ),
  },
  {
    name: "group_chat_members",
    columns: [
      "doco_id",
      "chat_user_id",
      "display_name",
      "real_name",
      "avatar_url",
      "is_bot",
      "deactivated",
    ],
    select: forDoco(
      "group_chat_members",
      [
        "doco_id",
        "chat_user_id",
        "display_name",
        "real_name",
        "avatar_url",
        "is_bot",
        "deactivated",
      ],
      "chat_user_id",
    ),
  },
  {
    name: "group_chat_messages",
    columns: [
      "doco_id",
      "channel_id",
      "ts",
      "thread_ts",
      "reply_count",
      "replies_cursor",
      "replies_synced_at",
      "author_id",
      "subtype",
      "text",
      "files",
      "edited_ts",
      "posted_at",
      "embedded_hash",
    ],
    jsonColumns: ["files"],
    casts: { files: "jsonb" },
    select: forDoco(
      "group_chat_messages",
      [
        "doco_id",
        "channel_id",
        "ts",
        "thread_ts",
        "reply_count",
        "replies_cursor",
        "replies_synced_at",
        "author_id",
        "subtype",
        "text",
        "files",
        "edited_ts",
        "posted_at",
        "embedded_hash",
      ],
      "channel_id, ts",
    ),
  },
  {
    name: "notion_mirrors",
    columns: [
      "doco_id",
      "workspace_id",
      "workspace_name",
      "workspace_icon",
      "bot_id",
      "access_token",
      "refresh_token",
      "authorized_by",
      "consented_by",
      "consented_at",
      "discovery_cursor",
      "discovery_started_at",
      "discovered_at",
      "reconciled_at",
      "users_cursor",
      "users_synced_at",
      "next_at",
      "ticked_at",
      "ticking_until",
      "needs_reauth_at",
      "listing_capped_at",
      "content_scan",
      "created_at",
    ],
    select: (docoId) => ({
      sql: `SELECT doco_id, workspace_id, workspace_name, workspace_icon, bot_id,
                   '${INERT_NOTION_TOKEN}'::text AS access_token, NULL::text AS refresh_token,
                   NULL::text AS authorized_by, NULL::text AS consented_by, consented_at,
                   discovery_cursor, discovery_started_at, discovered_at, reconciled_at,
                   users_cursor, users_synced_at, next_at, ticked_at, ticking_until,
                   COALESCE(needs_reauth_at, now()) AS needs_reauth_at,
                   listing_capped_at, content_scan, created_at
              FROM notion_mirrors WHERE doco_id = $1`,
      params: [docoId],
    }),
  },
  {
    name: "notion_pages",
    columns: [
      "doco_id",
      "page_id",
      "object",
      "parent_id",
      "parent_type",
      "title",
      "icon",
      "url",
      "properties",
      "markdown",
      "plain_text",
      "content_hash",
      "created_time",
      "last_edited_time",
      "last_edited_by",
      "truncated",
      "fetch_pending",
      "fetch_reason",
      "fetch_attempts",
      "fetch_error",
      "query_cursor",
      "seen_at",
      "synced_at",
      "embedded_hash",
    ],
    jsonColumns: ["properties"],
    casts: { properties: "jsonb" },
    select: forDoco(
      "notion_pages",
      [
        "doco_id",
        "page_id",
        "object",
        "parent_id",
        "parent_type",
        "title",
        "icon",
        "url",
        "properties",
        "markdown",
        "plain_text",
        "content_hash",
        "created_time",
        "last_edited_time",
        "last_edited_by",
        "truncated",
        "fetch_pending",
        "fetch_reason",
        "fetch_attempts",
        "fetch_error",
        "query_cursor",
        "seen_at",
        "synced_at",
        "embedded_hash",
      ],
      "page_id",
    ),
  },
  {
    name: "notion_links",
    columns: ["doco_id", "from_page_id", "to_page_id"],
    select: forDoco(
      "notion_links",
      ["doco_id", "from_page_id", "to_page_id"],
      "from_page_id, to_page_id",
    ),
  },
  {
    name: "notion_users",
    columns: ["doco_id", "user_id", "name", "avatar_url", "is_bot"],
    select: forDoco(
      "notion_users",
      ["doco_id", "user_id", "name", "avatar_url", "is_bot"],
      "user_id",
    ),
  },
  {
    name: "code_files",
    columns: ["doco_id", "repo", "path", "sha", "size", "content", "omitted", "synced_at"],
    select: forDoco(
      "code_files",
      ["doco_id", "repo", "path", "sha", "size", "content", "omitted", "synced_at"],
      "repo, path",
    ),
  },
  {
    name: "embeddings",
    columns: [
      "doco_id",
      "source",
      "entity_id",
      "chunk_index",
      "model_id",
      "content_hash",
      "chunk_text",
      "embedding",
      "updated_at",
    ],
    casts: { embedding: "vector" },
    select: (docoId) => ({
      sql: `SELECT doco_id, source, entity_id, chunk_index, model_id, content_hash,
                   chunk_text, embedding::text AS embedding, updated_at
              FROM embeddings WHERE doco_id = $1
             ORDER BY source, entity_id, chunk_index`,
      params: [docoId],
    }),
  },
];

function normalized(value: unknown): SnapshotValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("snapshot cannot encode a non-finite number");
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalized);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        normalized(child),
      ]),
    );
  }
  throw new Error(`snapshot cannot encode ${typeof value}`);
}

function normalizeRow(row: Record<string, unknown>): SnapshotRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalized(value)]));
}

function stable(value: SnapshotValue): SnapshotValue {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key] as SnapshotValue)]),
    );
  }
  return value;
}

function corpusPayload(snapshot: Pick<RetrievalSnapshot, "manifest" | "tables">): SnapshotValue {
  return {
    format: snapshot.manifest.format,
    version: snapshot.manifest.version,
    docoId: snapshot.manifest.docoId,
    docoHandle: snapshot.manifest.docoHandle,
    workspaceId: snapshot.manifest.workspaceId,
    tables: snapshot.tables,
  };
}

export function retrievalSnapshotDigest(
  snapshot: Pick<RetrievalSnapshot, "manifest" | "tables">,
): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(corpusPayload(snapshot))))
    .digest("hex");
}

function emptyTables(): RetrievalSnapshotTables {
  const tables = {} as RetrievalSnapshotTables;
  for (const name of TABLE_NAMES) tables[name] = [];
  return tables;
}

function safeDocoData(repos: string[]): SnapshotValue {
  return {
    retrieval_snapshot: true,
    github_integration: {
      connections: repos.map((repo) => ({ repo })),
      installations: [],
    },
  };
}

async function readRetrievalSnapshot(
  c: QueryClient,
  docoRef: string,
  options: ExportRetrievalSnapshotOptions = {},
): Promise<RetrievalSnapshot> {
  const docoResult = await c.query<{
    id: string;
    handle: string;
    workspace_id: string;
  }>(
    `SELECT id, handle, workspace_id FROM docos
      WHERE deleted_at IS NULL AND (id = $1 OR handle = $1)
      ORDER BY CASE WHEN id = $1 THEN 0 ELSE 1 END LIMIT 1`,
    [docoRef],
  );
  const doco = docoResult.rows[0];
  if (!doco) throw new Error(`Doco ${docoRef} was not found`);

  const tables = emptyTables();
  for (const spec of TABLE_SPECS) {
    const query = spec.select(doco.id, doco.workspace_id);
    const result = await c.query<Record<string, unknown>>(query.sql, query.params);
    tables[spec.name] = result.rows.map(normalizeRow);
  }

  const repos = [...new Set(tables.code_files.map((row) => String(row.repo)))].sort();
  if (tables.docos[0]) tables.docos[0].data = safeDocoData(repos);

  const postgresVersionResult = await c.query<{ version: string }>(
    "SELECT current_setting('server_version') AS version",
  );
  const vectorVersionResult = await c.query<{ extversion: string }>(
    "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
  );
  const modelIds = [...new Set(tables.embeddings.map((row) => String(row.model_id)))].sort();
  const rowCounts = Object.fromEntries(
    TABLE_NAMES.map((name) => [name, tables[name].length]),
  ) as Record<SnapshotTableName, number>;

  const snapshot: RetrievalSnapshot = {
    manifest: {
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      exportedAt: options.exportedAt ?? new Date().toISOString(),
      appRevision: options.appRevision ?? null,
      postgresVersion: postgresVersionResult.rows[0]?.version ?? "unknown",
      vectorExtensionVersion: vectorVersionResult.rows[0]?.extversion ?? null,
      docoId: doco.id,
      docoHandle: doco.handle,
      workspaceId: doco.workspace_id,
      modelIds,
      rowCounts,
      digest: "",
      containsProductionContent: true,
      credentialsIncluded: false,
    },
    tables,
  };
  snapshot.manifest.digest = retrievalSnapshotDigest(snapshot);
  return snapshot;
}

export async function exportRetrievalSnapshot(
  c: QueryClient,
  docoRef: string,
  options: ExportRetrievalSnapshotOptions = {},
): Promise<RetrievalSnapshot> {
  await c.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const snapshot = await readRetrievalSnapshot(c, docoRef, options);
    await c.query("COMMIT");
    return snapshot;
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  }
}

function assertSnapshot(snapshot: RetrievalSnapshot): void {
  if (
    snapshot.manifest.format !== SNAPSHOT_FORMAT ||
    snapshot.manifest.version !== SNAPSHOT_VERSION
  ) {
    throw new Error("unsupported retrieval snapshot format");
  }
  for (const name of TABLE_NAMES) {
    if (!Array.isArray(snapshot.tables[name])) throw new Error(`snapshot is missing table ${name}`);
    if (snapshot.manifest.rowCounts[name] !== snapshot.tables[name].length) {
      throw new Error(`snapshot row count mismatch for ${name}`);
    }
  }
  const actual = retrievalSnapshotDigest(snapshot);
  if (actual !== snapshot.manifest.digest) {
    throw new Error(
      `snapshot digest mismatch: expected ${snapshot.manifest.digest}, got ${actual}`,
    );
  }
}

function insertValue(spec: TableSpec, column: string, value: SnapshotValue): unknown {
  return spec.jsonColumns?.includes(column) && value !== null ? JSON.stringify(value) : value;
}

async function insertRows(c: QueryClient, spec: TableSpec, rows: SnapshotRow[]): Promise<void> {
  const batchSize = 100;
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const params: unknown[] = [];
    const values = batch.map((row) => {
      const placeholders = spec.columns.map((column) => {
        params.push(insertValue(spec, column, row[column] ?? null));
        const cast = spec.casts?.[column];
        return `$${params.length}${cast ? `::${cast}` : ""}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    await c.query(
      `INSERT INTO ${spec.name} (${spec.columns.join(", ")}) VALUES ${values.join(", ")}`,
      params,
    );
  }
}

export async function restoreRetrievalSnapshot(
  c: QueryClient,
  snapshot: RetrievalSnapshot,
): Promise<RestoreRetrievalSnapshotResult> {
  assertSnapshot(snapshot);
  await c.query("BEGIN");
  try {
    const existing = await c.query<{ present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM docos WHERE id = $1 OR handle = $2) AS present",
      [snapshot.manifest.docoId, snapshot.manifest.docoHandle],
    );
    if (existing.rows[0]?.present) {
      throw new Error(`target already contains Doco ${snapshot.manifest.docoId}`);
    }
    const workspace = await c.query<{ present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM workspaces WHERE id = $1 OR handle = $2) AS present",
      [snapshot.manifest.workspaceId, String(snapshot.tables.workspaces[0]?.handle ?? "")],
    );
    if (workspace.rows[0]?.present) {
      throw new Error(
        `target already contains workspace ${snapshot.manifest.workspaceId}; use an isolated database`,
      );
    }

    for (const spec of TABLE_SPECS) {
      if (spec.name === "node_touches") {
        // Node inserts regenerate touches. Replace them with the captured read-side state.
        await c.query("DELETE FROM node_touches WHERE doco_id = $1", [snapshot.manifest.docoId]);
      }
      await insertRows(c, spec, snapshot.tables[spec.name]);
    }
    // Edge inserts queue a PageRank rebuild. The captured ranks are the exact
    // read-side state under evaluation, so do not let a local sweep replace them.
    await c.query("DELETE FROM node_ranks_stale WHERE doco_id = $1", [snapshot.manifest.docoId]);
    const restored = await readRetrievalSnapshot(c, snapshot.manifest.docoId, {
      appRevision: snapshot.manifest.appRevision,
      exportedAt: snapshot.manifest.exportedAt,
    });
    if (restored.manifest.digest !== snapshot.manifest.digest) {
      throw new Error(
        `restored corpus digest mismatch: expected ${snapshot.manifest.digest}, got ${restored.manifest.digest}`,
      );
    }
    await c.query("COMMIT");
    return {
      docoId: snapshot.manifest.docoId,
      digest: restored.manifest.digest,
      rowCounts: restored.manifest.rowCounts,
    };
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  }
}
