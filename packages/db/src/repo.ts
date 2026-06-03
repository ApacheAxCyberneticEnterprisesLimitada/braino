// CRUD helpers for entity rows. Generic across categories via the maps
// in `./types.js`.
//
// Principals are role-personas in the graph; users are human OAuth
// identities. Membership + OAuth tables reference `user_id`.
// `docos.owner_id` is polymorphic: `user_<ulid>` or `workspace_<ulid>`.

import { randomBytes } from "node:crypto";
import { BLOCKED_NODE_JSON_EDGE_FIELD_SET, WRITE_ALL, normalizeWriteTypes } from "@doco/shared";
import type pg from "pg";
import { withClient } from "./client.js";
import {
  ALL_ENTITY_TABLES,
  type EntityRecord,
  NODE_PROMOTED_COLUMNS,
  NODE_TABLES,
  type PromotedColumnSpec,
} from "./types.js";

/** The 10 graph node types — all stored in the unified `nodes` table. */
const NODE_TYPE_SET: ReadonlySet<string> = new Set(Object.keys(NODE_TABLES));

function tableFor(entityType: string): {
  table: string;
  body: boolean;
  typeNamedColumn?: string;
} {
  const spec = ALL_ENTITY_TABLES[entityType];
  if (!spec) throw new Error(`Unknown entity type for storage: ${entityType}`);
  return spec;
}

/**
 * Drop prose aliases from a node's `data` jsonb before persisting. The merged
 * content already lives in the `prose` column; keeping a stale copy in `data`
 * would diverge on subsequent updates and leak into JSON API responses.
 */
const LEGACY_PROSE_KEYS = ["summary", "body_md", "title", "name", "description"] as const;

function stripLegacyProseKeys(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  for (const key of LEGACY_PROSE_KEYS) delete out[key];
  return out;
}

/**
 * Derive the `lifecycle` column from `data.lifecycle` (the source of
 * truth). If the caller also supplied `rec.lifecycle` and it disagrees,
 * log a warning — the call site is fighting itself.
 *
 * Returning a value from `data` keeps the column and the jsonb perfectly
 * aligned; the runner's loaders filter on the column, so drift would
 * silently disable enforcement.
 */
function deriveLifecycleColumn(rec: EntityRecord, data: Record<string, unknown>): string | null {
  const dataLifecycle = typeof data.lifecycle === "string" ? data.lifecycle : null;
  if (
    typeof rec.lifecycle === "string" &&
    dataLifecycle !== null &&
    rec.lifecycle !== dataLifecycle
  ) {
    console.warn(
      `[repo] lifecycle mismatch for ${rec.entity_type}/${rec.id}: rec.lifecycle=${rec.lifecycle} vs data.lifecycle=${dataLifecycle} — using data.lifecycle`,
    );
  }
  return dataLifecycle;
}

/**
 * Upsert one entity, routing by category:
 *  - the 10 graph node types (incl. principal) → the unified `nodes` table
 *  - the policy type → the per-Doco `policies` table
 *  - identity (workspace / doco / user) → richer per-table writers
 */
export async function upsertEntity(rec: EntityRecord, client?: pg.PoolClient): Promise<void> {
  const t = rec.entity_type;
  if (t === "workspace" || t === "doco" || t === "user") return upsertIdentity(rec, client);
  if (t === "policy") return upsertPolicy(rec, client);
  if (NODE_TYPE_SET.has(t)) return upsertNode(rec, client);
  throw new Error(`Unknown entity type for storage: ${t}`);
}

/** Resolve a promoted column's value from the entity's data bag. */
function promotedValue(pc: PromotedColumnSpec, data: Record<string, unknown>): string | null {
  const raw = data[pc.field];
  const v = typeof raw === "string" && raw.length > 0 ? raw : null;
  if (v !== null && pc.requirePrefix && !v.startsWith(pc.requirePrefix)) return null;
  return v;
}

/**
 * Upsert a graph node (any of the 10 types) into the unified `nodes` table.
 *
 * Prose: the prose nodes carry their content in `prose`; principals carry
 * name + body_md and leave prose = ''. Promoted scalar columns come from
 * NODE_PROMOTED_COLUMNS, and their keys are stripped from `data` so the typed
 * column is the single source of truth. Graph links live in `edges`.
 * `data.lifecycle` is the source of truth for the lifecycle column.
 */
async function upsertNode(rec: EntityRecord, client?: pg.PoolClient): Promise<void> {
  const t = rec.entity_type;
  const isPrincipal = t === "principal";
  const baseData = isPrincipal ? rec.data : stripLegacyProseKeys(rec.data);
  const cleanData = stripPromotedKeys(t, baseData);
  const lifecycleCol = deriveLifecycleColumn(rec, cleanData);

  const cols: string[] = [
    "id",
    "doco_id",
    "node_type",
    "lifecycle",
    "prose",
    "name",
    "body_md",
    "role_principal",
    "data",
  ];
  const vals: unknown[] = [
    rec.id,
    rec.doco_id,
    t,
    lifecycleCol,
    isPrincipal ? "" : (rec.type_named_value ?? ""),
    isPrincipal ? String(rec.data.name ?? rec.id) : null,
    isPrincipal ? (rec.body_md ?? null) : null,
    isPrincipal ? Boolean(rec.data.role_principal) : false,
    JSON.stringify(cleanData),
  ];
  for (const pc of NODE_PROMOTED_COLUMNS[t] ?? []) {
    cols.push(pc.column);
    vals.push(promotedValue(pc, rec.data));
  }
  cols.push("created_at", "created_by", "updated_at", "updated_by");
  vals.push(
    rec.created_at ?? new Date().toISOString(),
    rec.created_by ?? null,
    rec.updated_at ?? new Date().toISOString(),
    rec.updated_by ?? null,
  );
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
  // node_type is immutable (the id prefix encodes it); exclude it, id, and
  // created_* from the UPDATE set.
  const updates = cols
    .filter((c) => c !== "id" && c !== "node_type" && c !== "created_at" && c !== "created_by")
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(", ");
  const sql = `INSERT INTO nodes (${cols.join(",")}) VALUES (${placeholders})
               ON CONFLICT (id) DO UPDATE SET ${updates}`;
  const run = (c: pg.PoolClient) => c.query(sql, vals);
  if (client) {
    await run(client);
  } else {
    await withClient(async (c) => {
      await run(c);
    });
  }
}

/**
 * Upsert a policy into the per-Doco `policies` table. Policies are NOT folded
 * into `nodes` — they are governance config, not graph knowledge. The
 * standalone `kind` classifier is mirrored to a column for filtering; the rest
 * of the structured fields (predicate, on_violation, …) stay in `data`.
 */
async function upsertPolicy(rec: EntityRecord, client?: pg.PoolClient): Promise<void> {
  const spec = tableFor(rec.entity_type);
  const lifecycleCol = deriveLifecycleColumn(rec, rec.data);
  const cols = ["id", "doco_id", "lifecycle", "data", "kind"];
  const vals: unknown[] = [
    rec.id,
    rec.doco_id,
    lifecycleCol,
    JSON.stringify(rec.data),
    typeof rec.data.kind === "string" ? rec.data.kind : "",
  ];
  if (spec.body) {
    cols.push("body_md");
    vals.push(rec.body_md ?? null);
  }
  cols.push("created_at", "created_by", "updated_at", "updated_by");
  vals.push(
    rec.created_at ?? new Date().toISOString(),
    rec.created_by ?? null,
    rec.updated_at ?? new Date().toISOString(),
    rec.updated_by ?? null,
  );
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
  const updates = cols
    .filter((c) => c !== "id" && c !== "created_at" && c !== "created_by")
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(", ");
  const sql = `INSERT INTO ${spec.table} (${cols.join(",")}) VALUES (${placeholders})
               ON CONFLICT (id) DO UPDATE SET ${updates}`;
  const run = (c: pg.PoolClient) => c.query(sql, vals);
  if (client) {
    await run(client);
  } else {
    await withClient(async (c) => {
      await run(c);
    });
  }
}

/**
 * Keys stripped from the `data` jsonb before storage, so the typed column or
 * first-class edge is the single source of truth:
 *   - scalars promoted to typed columns (from NODE_PROMOTED_COLUMNS)
 *   - principal.role_principal (promoted to its own column by the writer)
 *   - graph-link field names; links live in `edges`.
 */
const STRIP_KEYS_BY_TYPE: Readonly<Record<string, ReadonlySet<string>>> = (() => {
  const out: Record<string, Set<string>> = {};
  for (const [type, columns] of Object.entries(NODE_PROMOTED_COLUMNS)) {
    const keys = new Set<string>();
    for (const pc of columns) if (pc.stripFromData) keys.add(pc.field);
    if (keys.size > 0) out[type] = keys;
  }
  // Principal's role_principal is promoted to its own column by the writer.
  out.principal = new Set(["role_principal"]);
  return out;
})();

function stripPromotedKeys(
  entityType: string,
  fm: Record<string, unknown>,
): Record<string, unknown> {
  const promoted = STRIP_KEYS_BY_TYPE[entityType];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (promoted?.has(k) || BLOCKED_NODE_JSON_EDGE_FIELD_SET.has(k)) continue;
    out[k] = v;
  }
  return out;
}

async function upsertIdentity(rec: EntityRecord, client?: pg.PoolClient): Promise<void> {
  const fields = rec.data;
  const run = async (c: pg.PoolClient) => {
    if (rec.entity_type === "user") {
      const dataJson = JSON.stringify(fields);
      const github_id = (fields.github_id as string | null) ?? null;
      const github_login = (fields.github_login as string | null) ?? null;
      const email = (fields.email as string | null) ?? null;
      const avatar_url = (fields.avatar_url as string | null) ?? null;
      const deactivated_at = (fields.deactivated_at as string | null) ?? null;
      await c.query(
        `INSERT INTO users (id, github_id, github_login, email, avatar_url, data, deactivated_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
         ON CONFLICT (id) DO UPDATE SET github_id=EXCLUDED.github_id, github_login=EXCLUDED.github_login,
           email=EXCLUDED.email, avatar_url=EXCLUDED.avatar_url,
           data=EXCLUDED.data, deactivated_at=EXCLUDED.deactivated_at, updated_at=now()`,
        [rec.id, github_id, github_login, email, avatar_url, dataJson, deactivated_at],
      );
    } else if (rec.entity_type === "workspace") {
      const dataJson = JSON.stringify(fields);
      const handle = String(fields.handle ?? rec.id);
      const name = String(fields.name ?? fields.display_name ?? handle);
      await c.query(
        `INSERT INTO workspaces (id, handle, name, data) VALUES ($1,$2,$3,$4::jsonb)
         ON CONFLICT (id) DO UPDATE SET handle=EXCLUDED.handle, name=EXCLUDED.name,
           data=EXCLUDED.data, updated_at=now()`,
        [rec.id, handle, name, dataJson],
      );
    } else if (rec.entity_type === "doco") {
      const dataFields = Object.fromEntries(
        Object.entries(fields).filter(([key]) => key !== "name" && key !== "display_name"),
      );
      const dataJson = JSON.stringify(dataFields);
      const owner_id = String(fields.owner_id ?? "");
      const workspace_id = String(fields.workspace_id ?? owner_id);
      const handle = String(fields.handle ?? "");
      if (!handle) {
        throw new Error(
          `Cannot upsert doco ${rec.id}: data is missing the required \`handle\` field.`,
        );
      }
      const visibility = String(fields.visibility ?? "private");
      await c.query(
        `INSERT INTO docos (id, handle, owner_id, workspace_id, visibility, data)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)
         ON CONFLICT (id) DO UPDATE SET handle=EXCLUDED.handle,
           owner_id=EXCLUDED.owner_id, workspace_id=EXCLUDED.workspace_id,
           visibility=EXCLUDED.visibility, data=EXCLUDED.data, updated_at=now()`,
        [rec.id, handle, owner_id, workspace_id, visibility, dataJson],
      );
    }
  };
  if (client) {
    await run(client);
  } else {
    await withClient(run);
  }
}

export async function getEntity(entityType: string, id: string): Promise<EntityRecord | null> {
  return withClient(async (c) => {
    const r = NODE_TYPE_SET.has(entityType)
      ? await c.query("SELECT * FROM nodes WHERE id = $1 AND node_type = $2", [id, entityType])
      : await c.query(`SELECT * FROM ${tableFor(entityType).table} WHERE id = $1`, [id]);
    if (r.rowCount === 0) return null;
    return rowToRecord(entityType, r.rows[0]);
  });
}

export async function listEntitiesByDoco(
  entityType: string,
  docoId: string,
): Promise<EntityRecord[]> {
  return withClient(async (c) => {
    const r = NODE_TYPE_SET.has(entityType)
      ? await c.query("SELECT * FROM nodes WHERE doco_id = $1 AND node_type = $2", [
          docoId,
          entityType,
        ])
      : await c.query(`SELECT * FROM ${tableFor(entityType).table} WHERE doco_id = $1`, [docoId]);
    return r.rows.map((row) => rowToRecord(entityType, row));
  });
}

/**
 * Like `listEntitiesByDoco`, but restricted to the given ids. Used by the
 * incremental reindex path so a one-entity capture doesn't drag every
 * row in the Doco off disk just to throw them away.
 */
export async function listEntitiesByDocoAndIds(
  entityType: string,
  docoId: string,
  ids: string[],
): Promise<EntityRecord[]> {
  if (ids.length === 0) return [];
  return withClient(async (c) => {
    const r = NODE_TYPE_SET.has(entityType)
      ? await c.query(
          "SELECT * FROM nodes WHERE doco_id = $1 AND node_type = $2 AND id = ANY($3::text[])",
          [docoId, entityType, ids],
        )
      : await c.query(
          `SELECT * FROM ${tableFor(entityType).table} WHERE doco_id = $1 AND id = ANY($2::text[])`,
          [docoId, ids],
        );
    return r.rows.map((row) => rowToRecord(entityType, row));
  });
}

export async function listIdentityRows(
  entityType: "principal" | "workspace" | "doco" | "user",
): Promise<EntityRecord[]> {
  return withClient(async (c) => {
    const r =
      entityType === "principal"
        ? await c.query("SELECT * FROM nodes WHERE node_type = 'principal'")
        : await c.query(`SELECT * FROM ${tableFor(entityType).table}`);
    return r.rows.map((row) => rowToRecord(entityType, row));
  });
}

/**
 * Columns promoted out of the `data` jsonb that we merge back INTO `data` on
 * read so downstream code that reads `rec.data.verb`, `rec.data.kind`, etc.
 * sees the structured values.
 */
const PROMOTED_COLUMNS_BY_TYPE: Record<string, readonly string[]> = {
  action: ["verb", "performed_at"],
  log: ["verb", "happened_at"],
  eval: ["kind"],
  rule: ["kind", "severity", "phase", "on_violation"],
  state: ["kind"],
  reference: ["ref_type", "locator", "citation", "title"],
  principal: ["role_principal"],
};

function rowToRecord(entityType: string, row: Record<string, unknown>): EntityRecord {
  // Merge promoted typed columns back into the data jsonb so callers that read
  // structured fields off `rec.data` still find them.
  const baseData = (row.data && typeof row.data === "object" ? row.data : {}) as Record<
    string,
    unknown
  >;
  const promoted = PROMOTED_COLUMNS_BY_TYPE[entityType] ?? [];
  const data: Record<string, unknown> = { ...baseData };
  for (const col of promoted) {
    if (col in row && row[col] !== null && row[col] !== undefined) {
      const v = row[col];
      // Timestamps come back as Date objects; serialize so the data
      // bag stays JSON-shaped.
      data[col] = v instanceof Date ? v.toISOString() : v;
    }
  }

  const rec: EntityRecord = {
    id: String(row.id),
    doco_id: row.doco_id ? String(row.doco_id) : "",
    entity_type: entityType,
    data,
  };
  if ("body_md" in row && row.body_md !== null) rec.body_md = String(row.body_md);
  if ("summary" in row && row.summary !== null) rec.summary = String(row.summary);
  if ("lifecycle" in row && row.lifecycle !== null) rec.lifecycle = String(row.lifecycle);
  if ("name" in row && row.name !== null) rec.name = String(row.name);
  // Hydrate the prose content. Unified `nodes` rows carry it in `prose`.
  // Empty string means "not set yet".
  if ("prose" in row && row.prose !== null && row.prose !== "") {
    rec.type_named_value = String(row.prose);
  }
  if (row.created_at instanceof Date) rec.created_at = row.created_at.toISOString();
  if ("created_by" in row && row.created_by !== null) rec.created_by = String(row.created_by);
  if (row.updated_at instanceof Date) rec.updated_at = row.updated_at.toISOString();
  if ("updated_by" in row && row.updated_by !== null) rec.updated_by = String(row.updated_by);
  return rec;
}

// ─── Host config ──────────────────────────────────────────────────────────

export interface HostConfigRow {
  id: string;
  name: string;
  visibility: "public" | "private";
  data: Record<string, unknown>;
}

export async function getHostConfig(): Promise<HostConfigRow | null> {
  return withClient(async (c) => {
    const r = await c.query("SELECT id, name, visibility, data FROM hosts LIMIT 1");
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    return {
      id: String(row.id),
      name: String(row.name),
      visibility: row.visibility === "public" ? "public" : "private",
      data: (row.data && typeof row.data === "object" ? row.data : {}) as Record<string, unknown>,
    };
  });
}

// ─── Users (human OAuth identity layer) ───────────────────────────

export interface UserRow {
  id: string;
  github_id: string | null;
  github_login: string | null;
  email: string | null;
  avatar_url: string | null;
  data: Record<string, unknown>;
}

function mapUserRow(row: Record<string, unknown>): UserRow {
  return {
    id: String(row.id),
    github_id: row.github_id === null || row.github_id === undefined ? null : String(row.github_id),
    github_login:
      row.github_login === null || row.github_login === undefined ? null : String(row.github_login),
    email: row.email === null || row.email === undefined ? null : String(row.email),
    avatar_url:
      row.avatar_url === null || row.avatar_url === undefined ? null : String(row.avatar_url),
    data: (row.data && typeof row.data === "object" ? row.data : {}) as Record<string, unknown>,
  };
}

export async function getUserById(id: string): Promise<UserRow | null> {
  return withClient(async (c) => {
    const r = await c.query(
      "SELECT id, github_id, github_login, email, avatar_url, data FROM users WHERE id = $1",
      [id],
    );
    if (r.rowCount === 0) return null;
    return mapUserRow(r.rows[0]);
  });
}

export async function getUserByGithubLogin(login: string): Promise<UserRow | null> {
  return withClient(async (c) => {
    const r = await c.query(
      "SELECT id, github_id, github_login, email, avatar_url, data FROM users WHERE github_login = $1",
      [login],
    );
    if (r.rowCount === 0) return null;
    return mapUserRow(r.rows[0]);
  });
}

/**
 * Patch a user's `data` JSONB column with `patch` — top-level
 * keys in `patch` replace their counterparts in `data`, anything else
 * stays. Used for per-user UI preferences (graph auto-reorder, etc.)
 * that don't merit their own column.
 */
export async function patchUserData(
  id: string,
  patch: Record<string, unknown>,
): Promise<UserRow | null> {
  return withClient(async (c) => {
    const r = await c.query(
      `UPDATE users
          SET data = data || $2::jsonb,
              updated_at = now()
        WHERE id = $1
      RETURNING id, github_id, github_login, email, avatar_url, data`,
      [id, JSON.stringify(patch)],
    );
    if (r.rowCount === 0) return null;
    return mapUserRow(r.rows[0]);
  });
}

export async function listUsers(): Promise<UserRow[]> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT id, github_id, github_login, email, avatar_url, data
       FROM users ORDER BY github_login NULLS LAST, id`,
    );
    return r.rows.map(mapUserRow);
  });
}

// ─── Principals (role-personas, node) ───────────────────────────────────
//
// Each Doco owns its own role-personas; the same name in two different Docos
// is two different rows.

export interface PrincipalRow {
  id: string;
  name: string;
  doco_id: string;
  data: Record<string, unknown>;
}

function mapPrincipalRow(row: Record<string, unknown>): PrincipalRow {
  return {
    id: String(row.id),
    name: String(row.name),
    doco_id: String(row.doco_id),
    data: (row.data && typeof row.data === "object" ? row.data : {}) as Record<string, unknown>,
  };
}

export async function getPrincipalById(id: string): Promise<PrincipalRow | null> {
  return withClient(async (c) => {
    const r = await c.query(
      "SELECT id, name, doco_id, data FROM nodes WHERE id = $1 AND node_type = 'principal'",
      [id],
    );
    if (r.rowCount === 0) return null;
    return mapPrincipalRow(r.rows[0]);
  });
}

/**
 * List Principals (role-personas) in a Doco.
 */
export async function listPrincipals(docoId: string): Promise<PrincipalRow[]> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT id, name, doco_id, data
       FROM nodes
       WHERE node_type = 'principal' AND doco_id = $1
       ORDER BY name, created_at, id`,
      [docoId],
    );
    return r.rows.map(mapPrincipalRow);
  });
}

// ─── Workspaces ────────────────────────────────────────────────────────

export interface WorkspaceRow {
  id: string;
  handle: string;
  name: string;
  /**
   * Free-form governing charter for the workspace — the standing "how work is
   * done here" text shared with agents granted access to the workspace at
   * bootstrap. Seeded with DEFAULT_WORKSPACE_CONSTITUTION on creation; editable
   * by workspace owners. Empty string only if an owner has explicitly cleared it.
   */
  constitution: string;
  data: Record<string, unknown>;
  member_count: number;
}

function mapWorkspaceRow(row: Record<string, unknown>): WorkspaceRow {
  return {
    id: String(row.id),
    handle: String(row.handle),
    name: String(row.name),
    constitution:
      row.constitution === null || row.constitution === undefined ? "" : String(row.constitution),
    data: (row.data && typeof row.data === "object" ? row.data : {}) as Record<string, unknown>,
    member_count: Number(row.member_count),
  };
}

export async function listWorkspaces(): Promise<WorkspaceRow[]> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT o.id, o.handle, o.name, o.constitution, o.data,
              COALESCE((SELECT count(*) FROM workspace_users m WHERE m.workspace_id = o.id), 0) AS member_count
       FROM workspaces o ORDER BY o.handle`,
    );
    return r.rows.map(mapWorkspaceRow);
  });
}

export async function getWorkspaceById(workspaceId: string): Promise<WorkspaceRow | null> {
  if (!workspaceId.startsWith("workspace_")) return null;
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT o.id, o.handle, o.name, o.constitution, o.data,
              COALESCE((SELECT count(*) FROM workspace_users m WHERE m.workspace_id = o.id), 0) AS member_count
       FROM workspaces o WHERE o.id = $1`,
      [workspaceId],
    );
    if (r.rowCount === 0) return null;
    return mapWorkspaceRow(r.rows[0]);
  });
}

export async function listWorkspacesForUser(
  userId: string,
  roles: string[] = ["owner", "writer", "reader"],
): Promise<WorkspaceRow[]> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT o.id, o.handle, o.name, o.constitution, o.data,
              COALESCE((SELECT count(*) FROM workspace_users m WHERE m.workspace_id = o.id), 0) AS member_count
       FROM workspaces o
       JOIN workspace_users m ON m.workspace_id = o.id
       WHERE m.user_id = $1 AND m.role = ANY($2)
       ORDER BY o.handle`,
      [userId, roles],
    );
    return r.rows.map(mapWorkspaceRow);
  });
}

export async function isWorkspaceUser(workspaceId: string, userId: string): Promise<boolean> {
  return withClient(async (c) => {
    const r = await c.query(
      "SELECT 1 FROM workspace_users WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userId],
    );
    return r.rowCount !== null && r.rowCount > 0;
  });
}

export async function upsertWorkspaceUser(opts: {
  workspace_id: string;
  user_id: string;
  role: DocoRole;
  /** Per-type write set; defaults to wildcard for writer, empty otherwise. */
  write_types?: string[];
}): Promise<void> {
  const writeTypes = normalizeGrantWriteTypes(opts.role, opts.write_types);
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO workspace_users (workspace_id, user_id, role, write_types)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, user_id)
       DO UPDATE SET role=EXCLUDED.role, write_types=EXCLUDED.write_types`,
      [opts.workspace_id, opts.user_id, opts.role, writeTypes],
    );
  });
}

export async function removeWorkspaceUser(workspaceId: string, userId: string): Promise<void> {
  await withClient(async (c) => {
    await c.query("DELETE FROM workspace_users WHERE workspace_id = $1 AND user_id = $2", [
      workspaceId,
      userId,
    ]);
  });
}

// ─── Role policies (decision_01KS0JBJ5X0AZ4XJJFKEWE1R62) ───────────────────

export type DocoRole = "owner" | "writer" | "reader";

export const ROLE_RANK: Record<DocoRole, number> = {
  owner: 2,
  writer: 1,
  reader: 0,
};

const ROLE_VALUES = new Set<DocoRole>(["owner", "writer", "reader"]);

function toRole(v: unknown): DocoRole | null {
  return typeof v === "string" && ROLE_VALUES.has(v as DocoRole) ? (v as DocoRole) : null;
}

export function roleAtLeast(role: DocoRole | null, threshold: DocoRole): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[threshold];
}

export function maxRole(...roles: (DocoRole | null | undefined)[]): DocoRole | null {
  let best: DocoRole | null = null;
  let bestRank = -1;
  for (const r of roles) {
    if (!r) continue;
    if (ROLE_RANK[r] > bestRank) {
      best = r;
      bestRank = ROLE_RANK[r];
    }
  }
  return best;
}

export async function getWorkspaceRole(
  workspaceId: string,
  userId: string,
): Promise<DocoRole | null> {
  return withClient(async (c) => {
    const r = await c.query<{ role: string }>(
      "SELECT role FROM workspace_users WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userId],
    );
    if (r.rowCount === 0) return null;
    return toRole(r.rows[0]?.role);
  });
}

/**
 * A membership grant: the role plus the per-type write set
 * (decision_per_type_write_grants). `writeTypes` holds writable-type
 * tokens (or the "*" wildcard); empty means "no write on any type"
 * unless the role is owner. Returns null when there is no grant row.
 */
export interface DocoGrant {
  role: DocoRole;
  writeTypes: string[];
}

function normalizeGrantWriteTypes(role: DocoRole, raw: unknown): string[] {
  const writeTypes = normalizeWriteTypes(raw);
  if (role === "owner") return [];
  if (role === "writer" && writeTypes.length === 0) return [WRITE_ALL];
  return writeTypes;
}

export async function getWorkspaceGrant(
  workspaceId: string,
  userId: string,
): Promise<DocoGrant | null> {
  return withClient(async (c) => {
    const r = await c.query<{ role: string; write_types: string[] }>(
      "SELECT role, write_types FROM workspace_users WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userId],
    );
    if (r.rowCount === 0) return null;
    const role = toRole(r.rows[0]?.role);
    if (!role) return null;
    return { role, writeTypes: normalizeGrantWriteTypes(role, r.rows[0]?.write_types) };
  });
}

export async function getDocoUserGrant(docoId: string, userId: string): Promise<DocoGrant | null> {
  return withClient(async (c) => {
    const r = await c.query<{ role: string; write_types: string[] }>(
      "SELECT role, write_types FROM doco_users WHERE doco_id = $1 AND user_id = $2",
      [docoId, userId],
    );
    if (r.rowCount === 0) return null;
    const role = toRole(r.rows[0]?.role);
    if (!role) return null;
    return { role, writeTypes: normalizeGrantWriteTypes(role, r.rows[0]?.write_types) };
  });
}

/** User ids that hold owner role on this workspace (the workspace's account owners). */
export async function listWorkspaceOwnerUserIds(workspaceId: string): Promise<string[]> {
  return withClient(async (c) => {
    const r = await c.query<{ user_id: string }>(
      "SELECT user_id FROM workspace_users WHERE workspace_id = $1 AND role = 'owner'",
      [workspaceId],
    );
    return r.rows.map((row) => String(row.user_id));
  });
}

// ─── account_grants ────────────────────────────────────────────────────────

export interface AccountGrantRow {
  grantor_user_id: string;
  grantee_user_id: string;
  role: DocoRole;
  write_types: string[];
}

/** The account grant `granteeUserId` holds from `grantorUserId`, or null. */
export async function getAccountGrant(
  grantorUserId: string,
  granteeUserId: string,
): Promise<DocoGrant | null> {
  return withClient(async (c) => {
    const r = await c.query<{ role: string; write_types: string[] }>(
      `SELECT role, write_types FROM account_grants
         WHERE grantor_user_id = $1 AND grantee_user_id = $2`,
      [grantorUserId, granteeUserId],
    );
    if (r.rowCount === 0) return null;
    const role = toRole(r.rows[0]?.role);
    if (!role) return null;
    return { role, writeTypes: normalizeGrantWriteTypes(role, r.rows[0]?.write_types) };
  });
}

export async function upsertAccountGrant(opts: {
  grantor_user_id: string;
  grantee_user_id: string;
  role: DocoRole;
  write_types?: string[];
}): Promise<void> {
  const writeTypes = normalizeGrantWriteTypes(opts.role, opts.write_types);
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO account_grants (grantor_user_id, grantee_user_id, role, write_types)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (grantor_user_id, grantee_user_id)
       DO UPDATE SET role = EXCLUDED.role, write_types = EXCLUDED.write_types`,
      [opts.grantor_user_id, opts.grantee_user_id, opts.role, writeTypes],
    );
  });
}

export async function removeAccountGrant(
  grantorUserId: string,
  granteeUserId: string,
): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      "DELETE FROM account_grants WHERE grantor_user_id = $1 AND grantee_user_id = $2",
      [grantorUserId, granteeUserId],
    );
  });
}

// ─── doco_users ────────────────────────────────────────────────────────────

export interface DocoUserRow {
  doco_id: string;
  user_id: string;
  role: DocoRole;
  write_types: string[];
  joined_at: string;
}

export async function getDocoUserRole(docoId: string, userId: string): Promise<DocoRole | null> {
  return withClient(async (c) => {
    const r = await c.query<{ role: string }>(
      "SELECT role FROM doco_users WHERE doco_id = $1 AND user_id = $2",
      [docoId, userId],
    );
    if (r.rowCount === 0) return null;
    return toRole(r.rows[0]?.role);
  });
}

export async function listDocoUsers(docoId: string): Promise<DocoUserRow[]> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT doco_id, user_id, role, write_types, joined_at FROM doco_users
       WHERE doco_id = $1 ORDER BY joined_at`,
      [docoId],
    );
    return r.rows.map((row) => {
      const role = toRole(row.role) ?? "reader";
      return {
        doco_id: String(row.doco_id),
        user_id: String(row.user_id),
        role,
        write_types: normalizeGrantWriteTypes(role, row.write_types),
        joined_at:
          row.joined_at instanceof Date ? row.joined_at.toISOString() : String(row.joined_at),
      };
    });
  });
}

export async function listDocoIdsForUser(userId: string): Promise<string[]> {
  return withClient(async (c) => {
    const r = await c.query<{ doco_id: string }>(
      "SELECT doco_id FROM doco_users WHERE user_id = $1",
      [userId],
    );
    return r.rows.map((row) => String(row.doco_id));
  });
}

export async function upsertDocoUser(opts: {
  doco_id: string;
  user_id: string;
  role: DocoRole;
  /** Per-type write set; defaults to wildcard for writer, empty otherwise. */
  write_types?: string[];
}): Promise<void> {
  const writeTypes = normalizeGrantWriteTypes(opts.role, opts.write_types);
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO doco_users (doco_id, user_id, role, write_types)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (doco_id, user_id)
       DO UPDATE SET role = EXCLUDED.role, write_types = EXCLUDED.write_types`,
      [opts.doco_id, opts.user_id, opts.role, writeTypes],
    );
  });
}

export async function removeDocoUser(docoId: string, userId: string): Promise<void> {
  await withClient(async (c) => {
    await c.query("DELETE FROM doco_users WHERE doco_id = $1 AND user_id = $2", [docoId, userId]);
  });
}

// ─── Access requests ────────────────────────────────────────────────────────

export interface AccessRequestRow {
  id: string;
  doco_id: string;
  requester_id: string;
  requested_role: DocoRole;
  reason: string | null;
  status: "pending" | "approved" | "denied" | "cancelled";
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

function mapAccessRequestRow(r: Record<string, unknown>): AccessRequestRow {
  return {
    id: String(r.id),
    doco_id: String(r.doco_id),
    requester_id: String(r.requester_id),
    requested_role: r.requested_role as DocoRole,
    reason: r.reason == null ? null : String(r.reason),
    status: r.status as AccessRequestRow["status"],
    created_at: String(r.created_at),
    decided_at: r.decided_at == null ? null : String(r.decided_at),
    decided_by: r.decided_by == null ? null : String(r.decided_by),
  };
}

/**
 * Create (or refresh) the caller's pending access request for a Doco. The
 * partial unique index permits one live request per (doco, requester), so a
 * repeat upserts the role/reason instead of duplicating. Writing the grant on
 * approval is the caller's job (see `decideAccessRequest` + `upsertDocoUser`).
 */
export async function createAccessRequest(opts: {
  doco_id: string;
  requester_id: string;
  requested_role: DocoRole;
  reason?: string | null;
}): Promise<AccessRequestRow> {
  const id = `accreq_${randomBytes(16).toString("base64url")}`;
  return withClient(async (c) => {
    const r = await c.query(
      `INSERT INTO access_requests (id, doco_id, requester_id, requested_role, reason)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (doco_id, requester_id) WHERE status = 'pending'
       DO UPDATE SET requested_role = EXCLUDED.requested_role,
                     reason = EXCLUDED.reason,
                     created_at = now()
       RETURNING *`,
      [id, opts.doco_id, opts.requester_id, opts.requested_role, opts.reason ?? null],
    );
    return mapAccessRequestRow(r.rows[0] as Record<string, unknown>);
  });
}

export async function getAccessRequest(id: string): Promise<AccessRequestRow | null> {
  return withClient(async (c) => {
    const r = await c.query("SELECT * FROM access_requests WHERE id = $1", [id]);
    return r.rows[0] ? mapAccessRequestRow(r.rows[0] as Record<string, unknown>) : null;
  });
}

/** Pending requests across a set of Docos (an owner's inbox), oldest first. */
export async function listPendingAccessRequestsForDocos(
  docoIds: string[],
): Promise<AccessRequestRow[]> {
  if (docoIds.length === 0) return [];
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT * FROM access_requests
       WHERE status = 'pending' AND doco_id = ANY($1::text[])
       ORDER BY created_at ASC`,
      [docoIds],
    );
    return r.rows.map((row) => mapAccessRequestRow(row as Record<string, unknown>));
  });
}

/**
 * Flip a pending request to approved/denied. Returns the updated row, or null
 * if it was not pending (already decided or unknown id) — callers treat null
 * as "nothing to do". A pure status transition; on approval the caller writes
 * the grant via `upsertDocoUser`.
 */
export async function decideAccessRequest(opts: {
  id: string;
  status: "approved" | "denied";
  decided_by: string;
}): Promise<AccessRequestRow | null> {
  return withClient(async (c) => {
    const r = await c.query(
      `UPDATE access_requests
       SET status = $2, decided_at = now(), decided_by = $3
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [opts.id, opts.status, opts.decided_by],
    );
    return r.rows[0] ? mapAccessRequestRow(r.rows[0] as Record<string, unknown>) : null;
  });
}

/** The requester withdraws their own pending request. */
export async function cancelAccessRequest(id: string, requesterId: string): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `UPDATE access_requests SET status = 'cancelled', decided_at = now()
       WHERE id = $1 AND requester_id = $2 AND status = 'pending'`,
      [id, requesterId],
    );
  });
}

// ─── Docos ────────────────────────────────────────────────────────────────

export interface DocoRow {
  id: string;
  handle: string;
  /**
   * Owner label — User.github_login for human/agent owners,
   * Workspace.handle for workspace owners. Derived via JOIN in `mapDocoRow`
   * from `owner_id`. NOT a doco identifier.
   */
  owner_slug: string;
  owner_id: string;
  workspace_id: string;
  visibility: "public" | "private";
  goal: string;
  data: Record<string, unknown>;
  /**
   * Template-seeded default lifecycle for new nodes captured into this
   * Doco (e.g. `org-chart` / `glossaries` / `business-processes` ship
   * `drafting`). Null when the Doco's template set no default; capture
   * then falls back to each node type's built-in default.
   */
  default_node_lifecycle: string | null;
}

function mapDocoRow(row: Record<string, unknown>): DocoRow {
  return {
    id: String(row.id),
    handle: String(row.handle ?? ""),
    owner_slug: String(row.owner_slug ?? ""),
    owner_id: String(row.owner_id),
    workspace_id: String(row.workspace_id ?? row.owner_id),
    visibility: row.visibility === "public" ? "public" : "private",
    goal: row.goal === null || row.goal === undefined ? "" : String(row.goal),
    data: (row.data && typeof row.data === "object" ? row.data : {}) as Record<string, unknown>,
    default_node_lifecycle:
      typeof row.default_node_lifecycle === "string" ? row.default_node_lifecycle : null,
  };
}

/**
 * Resolves `owner_slug` from `users.github_login` /
 * `workspaces.handle` keyed by `docos.owner_id`.
 */
const DOCO_SELECT = `
  SELECT d.id, d.handle, d.owner_id, d.workspace_id, d.visibility, d.goal, d.data,
         d.default_node_lifecycle,
         COALESCE(c.github_login, o.handle, '') AS owner_slug
    FROM docos d
    LEFT JOIN users c ON c.id = d.owner_id
    LEFT JOIN workspaces o ON o.id = d.owner_id`;

export async function listAllDocos(): Promise<DocoRow[]> {
  return withClient(async (c) => {
    const r = await c.query(`${DOCO_SELECT} ORDER BY d.handle`);
    return r.rows.map(mapDocoRow);
  });
}

export async function getDocoById(docoId: string): Promise<DocoRow | null> {
  return withClient(async (c) => {
    const r = await c.query(`${DOCO_SELECT} WHERE d.id = $1`, [docoId]);
    if (r.rowCount === 0) return null;
    return mapDocoRow(r.rows[0]);
  });
}

export async function getDocoByHandle(handle: string): Promise<DocoRow | null> {
  return withClient(async (c) => {
    const r = await c.query(`${DOCO_SELECT} WHERE d.handle = $1`, [handle]);
    if (r.rowCount === 0) return null;
    return mapDocoRow(r.rows[0]);
  });
}

export async function getDocoByIdOrHandle(idOrHandle: string): Promise<DocoRow | null> {
  if (idOrHandle.startsWith("doco_")) {
    const byId = await getDocoById(idOrHandle);
    if (byId) return byId;
  }
  return getDocoByHandle(idOrHandle);
}

/**
 * A single workspace's constitution for the agent-bootstrap manifest.
 */
export interface WorkspaceConstitution {
  workspace_id: string;
  workspace_handle: string;
  constitution: string;
}

/**
 * Fetch the constitutions of the given workspaces, skipping any with an empty
 * constitution. Used by the agent-bootstrap manifest to surface the
 * charter of every workspace the caller can reach. Deduplicates input ids.
 */
export async function getWorkspaceConstitutionsByIds(
  ids: string[],
): Promise<WorkspaceConstitution[]> {
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return [];
  return withClient(async (c) => {
    const r = await c.query<{ id: string; handle: string; constitution: string }>(
      `SELECT id, handle, constitution
         FROM workspaces
        WHERE id = ANY($1::text[]) AND constitution <> ''
        ORDER BY handle`,
      [unique],
    );
    return r.rows.map((row) => ({
      workspace_id: String(row.id),
      workspace_handle: String(row.handle),
      constitution: String(row.constitution),
    }));
  });
}

/**
 * Update an workspace's constitution. Empty string clears it. Returns false when
 * no workspace with that id exists.
 */
export async function updateWorkspaceConstitution(
  workspaceId: string,
  constitution: string,
): Promise<boolean> {
  return withClient(async (c) => {
    const r = await c.query(
      "UPDATE workspaces SET constitution = $2, updated_at = now() WHERE id = $1",
      [workspaceId, constitution],
    );
    return (r.rowCount ?? 0) > 0;
  });
}

// ─── Audit events ─────────────────────────────────────────────────────────

export interface AuditEventRow {
  event_id: string;
  at: string;
  by_user: string | null;
  doco_id: string | null;
  workspace_id?: string | null;
  entity_type: string;
  entity_id: string;
  op: string;
  before_json?: Record<string, unknown> | null;
  after_json?: Record<string, unknown> | null;
  reason?: string | null;
}

export async function appendAuditEventRow(evt: AuditEventRow): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO audit_events (event_id, at, by_user, doco_id, workspace_id, entity_type, entity_id, op, before_json, after_json, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        evt.event_id,
        evt.at,
        evt.by_user,
        evt.doco_id,
        evt.workspace_id ?? null,
        evt.entity_type,
        evt.entity_id,
        evt.op,
        evt.before_json ? JSON.stringify(evt.before_json) : null,
        evt.after_json ? JSON.stringify(evt.after_json) : null,
        evt.reason ?? null,
      ],
    );
  });
}

export async function readAuditEventRows(filters: {
  doco_id?: string;
  workspace_id?: string;
  entity_id?: string;
  entity_type?: string;
  op?: string[];
  by?: string;
  since?: string;
  before?: string;
  until?: string;
  limit?: number;
}): Promise<AuditEventRow[]> {
  const where: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;
  if (filters.doco_id) {
    where.push(`doco_id = $${idx++}`);
    vals.push(filters.doco_id);
  }
  if (filters.workspace_id) {
    where.push(`workspace_id = $${idx++}`);
    vals.push(filters.workspace_id);
  }
  if (filters.entity_id) {
    where.push(`entity_id = $${idx++}`);
    vals.push(filters.entity_id);
  }
  if (filters.entity_type) {
    where.push(`entity_type = $${idx++}`);
    vals.push(filters.entity_type);
  }
  if (filters.op && filters.op.length > 0) {
    where.push(`op = ANY($${idx++})`);
    vals.push(filters.op);
  }
  if (filters.by) {
    where.push(`by_user = $${idx++}`);
    vals.push(filters.by);
  }
  if (filters.since) {
    where.push(`at >= $${idx++}`);
    vals.push(filters.since);
  }
  if (filters.before) {
    where.push(`at < $${idx++}`);
    vals.push(filters.before);
  }
  if (filters.until) {
    where.push(`at <= $${idx++}`);
    vals.push(filters.until);
  }
  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 1000);
  const sql = `SELECT event_id, at, by_user, doco_id, workspace_id, entity_type, entity_id, op, before_json, after_json, reason
               FROM audit_events
               ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY at DESC
               LIMIT $${idx}`;
  vals.push(limit);
  return withClient(async (c) => {
    const r = await c.query(sql, vals);
    return r.rows.map((row) => ({
      event_id: String(row.event_id),
      at: row.at instanceof Date ? row.at.toISOString() : String(row.at),
      by_user: row.by_user ? String(row.by_user) : null,
      doco_id: row.doco_id ? String(row.doco_id) : null,
      workspace_id: row.workspace_id ? String(row.workspace_id) : null,
      entity_type: String(row.entity_type),
      entity_id: String(row.entity_id),
      op: String(row.op),
      before_json: row.before_json ?? null,
      after_json: row.after_json ?? null,
      reason: row.reason ?? null,
    }));
  });
}
