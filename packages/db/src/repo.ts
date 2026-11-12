// CRUD helpers for entity rows. Generic across categories via the maps
// in `./types.js`.
//
// Principals are role-personas in the graph; users are human OAuth
// identities. Membership + OAuth tables reference `user_id`.
// `collections.owner_id` is polymorphic: `user_<ulid>` or `workspace_<ulid>`.

import { randomBytes } from "node:crypto";
import { BLOCKED_NODE_JSON_EDGE_FIELD_SET, WRITE_ALL, normalizeWriteTypes } from "@doco/shared";
import type pg from "pg";
import { withClient } from "./client.js";
import {
  NODE_PROMOTED_COLUMNS,
  NODE_TABLES,
  type NodeRow,
  type PolicyWrite,
  type PromotedColumnSpec,
} from "./types.js";

/** The 10 graph node types — all stored in the unified `nodes` table. */
const NODE_TYPE_SET: ReadonlySet<string> = new Set(Object.keys(NODE_TABLES));

/**
 * Drop prose aliases from a node's `data` jsonb before persisting. The merged
 * content already lives in the `prose` column; keeping a stale copy in `data`
 * would diverge on subsequent updates and leak into JSON API responses.
 */
const LEGACY_PROSE_KEYS = ["summary", "name", "description"] as const;

function stripLegacyProseKeys(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  for (const key of LEGACY_PROSE_KEYS) delete out[key];
  return out;
}

/**
 * Node-shape slim-down (expand phase). Build the unified `extra` bag: the
 * per-node domain fields, with everything that lives in a real column or in
 * `prose` excluded. This is the future single home for the per-type promoted
 * scalars (severity, verb, locator, …) plus any free-form per-type data (a
 * reference's PR body / word definition, a decision's alternatives, …).
 *
 * The schema.sql backfill mirrors this exclusion set for pre-existing rows.
 */
const EXTRA_EXCLUDED_KEYS: ReadonlySet<string> = new Set<string>([
  // identity / audit / lifecycle — real columns
  "id",
  "collection_id",
  "node_type",
  "lifecycle",
  "created_at",
  "created_by",
  "updated_at",
  "updated_by",
  // prose + historical aliases — the `prose` column
  "prose",
  "summary",
  "description",
  // principal label → `prose`; the dropped role flag. `body_md` is excluded:
  // the node model has no body — a node's only text is `prose`, so nothing is
  // ever stored under `body_md` in the bag.
  "name",
  "role_principal",
  "body_md",
  // Entity-shape normalization (slice C): retired fields. A reference's type is
  // implied by its `locator`; rule enforcement lives in Policy records, not a
  // `severity` string; the title is the `prose`. Excluded so a stale client that
  // still sends one never re-persists it into the bag (the schema.sql migration
  // strips any already stored).
  "ref_type",
  "citation",
  "severity",
  "title",
  "body",
  // columns we keep promoted
  "kind",
  "locator",
  "proposer_id",
  // the type-named prose fields (intent, decision, …); only the node's own is
  // ever present, but excluding all is safe since no domain field shares a name
  ...NODE_TYPE_SET,
]);

function buildExtra(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    if (EXTRA_EXCLUDED_KEYS.has(k) || BLOCKED_NODE_JSON_EDGE_FIELD_SET.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Resolve a promoted column's value from the entity's data bag. */
function promotedValue(pc: PromotedColumnSpec, data: Record<string, unknown>): string | null {
  const raw = data[pc.field];
  const v = typeof raw === "string" && raw.length > 0 ? raw : null;
  if (v !== null && pc.requirePrefix && !v.startsWith(pc.requirePrefix)) return null;
  return v;
}

/**
 * Split a captured field bag into the honest `NodeRow` the writer stores: the
 * one boundary where a loose request shape becomes typed columns + `extra`.
 * `prose` is the text column; the promoted scalars (`kind`/`locator`/
 * `proposer_id`, per `NODE_PROMOTED_COLUMNS`) become their columns; every other
 * domain field lands in `extra`; identity/audit/lifecycle map straight across.
 * This is the WRITE counterpart of `rowToNode` (the read mapper) — both yield a
 * `NodeRow`, so a node has one in-memory shape on both sides.
 */
export function nodeRowFromFields(nodeType: string, fields: Record<string, unknown>): NodeRow {
  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  const promoted = (column: string): string | null => {
    const pc = (NODE_PROMOTED_COLUMNS[nodeType] ?? []).find((p) => p.column === column);
    return pc ? promotedValue(pc, fields) : null;
  };
  return {
    id: String(fields.id),
    collection_id: fields.collection_id ? String(fields.collection_id) : "",
    node_type: nodeType,
    lifecycle: str(fields.lifecycle),
    prose: typeof fields.prose === "string" ? fields.prose : "",
    extra: buildExtra(stripLegacyProseKeys(fields)),
    kind: promoted("kind"),
    locator: promoted("locator"),
    proposer_id: promoted("proposer_id"),
    created_at: str(fields.created_at),
    created_by: str(fields.created_by),
    updated_at: str(fields.updated_at),
    updated_by: str(fields.updated_by),
  };
}

/**
 * Upsert a graph node (any of the 10 types) into the unified `nodes` table from
 * the honest `NodeRow`: every field maps straight to its column, `extra` to the
 * jsonb. No bag-splitting here — that's `nodeRowFromFields`'s job at the write
 * boundary. Graph links live in `edges`. `node.lifecycle` drives the column.
 */
export async function upsertNode(node: NodeRow, client?: pg.PoolClient): Promise<void> {
  const t = node.node_type;
  const cols: string[] = ["id", "collection_id", "node_type", "lifecycle", "prose", "extra"];
  const vals: unknown[] = [
    node.id,
    node.collection_id,
    t,
    node.lifecycle,
    node.prose,
    JSON.stringify(node.extra),
  ];
  for (const pc of NODE_PROMOTED_COLUMNS[t] ?? []) {
    cols.push(pc.column);
    vals.push((node as unknown as Record<string, unknown>)[pc.column] ?? null);
  }
  cols.push("created_at", "created_by", "updated_at", "updated_by");
  vals.push(
    node.created_at ?? new Date().toISOString(),
    node.created_by ?? null,
    node.updated_at ?? new Date().toISOString(),
    node.updated_by ?? null,
  );
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
  // A node's identity never changes on conflict: its id, its type (the id
  // prefix encodes it), the collection it belongs to, and who created it when.
  // Excluding collection_id is what keeps a write that names another
  // collection from moving the node there (2026-10-28 security review).
  const IDENTITY = new Set(["id", "node_type", "collection_id", "created_at", "created_by"]);
  const updates = cols
    .filter((c) => !IDENTITY.has(c))
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
 * Upsert a policy into the per-collection `policies` table. Policies are NOT folded
 * into `nodes` — they are governance config, not graph knowledge. Unlike nodes,
 * a policy keeps its real `policies.data` jsonb (the structured predicate /
 * on_violation / fires_when fields); the standalone `kind` classifier is
 * mirrored to its own column for filtering. `policy.lifecycle` drives the column.
 */
export async function upsertPolicy(policy: PolicyWrite, client?: pg.PoolClient): Promise<void> {
  const cols = ["id", "collection_id", "lifecycle", "data", "kind"];
  const vals: unknown[] = [
    policy.id,
    policy.collection_id,
    policy.lifecycle,
    JSON.stringify(policy.data),
    typeof policy.data.kind === "string" ? policy.data.kind : "",
  ];
  cols.push("created_at", "created_by", "updated_at", "updated_by");
  vals.push(
    policy.created_at ?? new Date().toISOString(),
    policy.created_by ?? null,
    policy.updated_at ?? new Date().toISOString(),
    policy.updated_by ?? null,
  );
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
  const updates = cols
    .filter((c) => c !== "id" && c !== "created_at" && c !== "created_by")
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(", ");
  const sql = `INSERT INTO policies (${cols.join(",")}) VALUES (${placeholders})
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

// Reads are node-only: policies are read through the bespoke policy path and
// identity rows (user/collection/workspace) through their own row readers. Every node
// type lives in the `nodes` table; `node_type` is the discriminator.

export async function getEntity(nodeType: string, id: string): Promise<NodeRow | null> {
  return withClient(async (c) => {
    const r = await c.query("SELECT * FROM nodes WHERE id = $1 AND node_type = $2", [id, nodeType]);
    // Guard on the row itself, not `rowCount`: PGlite reports `rowCount` as
    // null (not 0) for a 0-row SELECT. `!r.rows[0]` is correct under pg and PGlite.
    if (!r.rows[0]) return null;
    return rowToNode(r.rows[0]);
  });
}

/** The distinct types of the active edges touching a node, in either direction. */
export async function listActiveEdgeTypesForNode(
  collectionId: string,
  nodeId: string,
): Promise<string[]> {
  return withClient(async (c) => {
    const r = await c.query<{ edge_type: string }>(
      `SELECT DISTINCT edge_type FROM edges
        WHERE collection_id = $1 AND lifecycle = 'active' AND (from_id = $2 OR to_id = $2)
        ORDER BY edge_type`,
      [collectionId, nodeId],
    );
    return r.rows.map((row) => row.edge_type);
  });
}

export async function listNodesByCollection(
  nodeType: string,
  collectionId: string,
): Promise<NodeRow[]> {
  return withClient(async (c) => {
    const r = await c.query("SELECT * FROM nodes WHERE collection_id = $1 AND node_type = $2", [
      collectionId,
      nodeType,
    ]);
    return r.rows.map(rowToNode);
  });
}

/**
 * Like `listNodesByCollection`, but restricted to the given ids. Used by the
 * incremental reindex path so a one-node capture doesn't drag every
 * row in the collection off disk just to throw them away.
 */
export async function listNodesByCollectionAndIds(
  nodeType: string,
  collectionId: string,
  ids: string[],
): Promise<NodeRow[]> {
  if (ids.length === 0) return [];
  return withClient(async (c) => {
    const r = await c.query(
      "SELECT * FROM nodes WHERE collection_id = $1 AND node_type = $2 AND id = ANY($3::text[])",
      [collectionId, nodeType, ids],
    );
    return r.rows.map(rowToNode);
  });
}

/**
 * Map a `nodes` row to the honest `NodeRow` — one field per real column, the
 * `extra` jsonb parsed, timestamps ISO-formatted. There is no synthetic `data`
 * bag: the promoted columns (`kind`/`locator`/`proposer_id`) and `prose` are
 * read straight off their columns, and every other per-node domain field lives
 * in `extra`.
 */
export function rowToNode(row: Record<string, unknown>): NodeRow {
  const iso = (v: unknown): string | null =>
    v instanceof Date ? v.toISOString() : typeof v === "string" && v !== "" ? v : null;
  const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
  return {
    id: String(row.id),
    collection_id: row.collection_id ? String(row.collection_id) : "",
    node_type: row.node_type ? String(row.node_type) : "",
    lifecycle: str(row.lifecycle),
    prose: typeof row.prose === "string" ? row.prose : "",
    extra: row.extra && typeof row.extra === "object" ? (row.extra as Record<string, unknown>) : {},
    kind: str(row.kind),
    locator: str(row.locator),
    proposer_id: str(row.proposer_id),
    created_at: iso(row.created_at),
    created_by: str(row.created_by),
    updated_at: iso(row.updated_at),
    updated_by: str(row.updated_by),
  };
}

// ─── Host config ──────────────────────────────────────────────────────────

export interface HostConfigRow {
  id: string;
  name: string;
  visibility: "public" | "private";
}

export async function getHostConfig(): Promise<HostConfigRow | null> {
  return withClient(async (c) => {
    const r = await c.query("SELECT id, name, visibility FROM hosts LIMIT 1");
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    return {
      id: String(row.id),
      name: String(row.name),
      visibility: row.visibility === "public" ? "public" : "private",
    };
  });
}

// ─── Users (the people who sign in) ───────────────────────────────

export interface UserRow {
  id: string;
  username: string | null;
  /** What they are called ("Alex Torrenegra"), or null until they write it. */
  name: string | null;
  github_login: string | null;
  email: string | null;
  /** Whether they are the host superadmin, whom Braino's admin pages answer. */
  superadmin: boolean;
  data: Record<string, unknown>;
}

const USER_COLUMNS = "id, username, name, github_login, email, superadmin, data";

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function mapUserRow(row: Record<string, unknown>): UserRow {
  return {
    id: String(row.id),
    username: nullableString(row.username),
    name: nullableString(row.name),
    github_login: nullableString(row.github_login),
    email: nullableString(row.email),
    superadmin: row.superadmin === true,
    data: (row.data && typeof row.data === "object" ? row.data : {}) as Record<string, unknown>,
  };
}

async function findUser(where: string, value: string): Promise<UserRow | null> {
  return withClient(async (c) => {
    const r = await c.query(`SELECT ${USER_COLUMNS} FROM users WHERE ${where} LIMIT 1`, [value]);
    if (r.rows.length === 0) return null;
    return mapUserRow(r.rows[0]);
  });
}

export async function getUserById(id: string): Promise<UserRow | null> {
  return findUser("id = $1", id);
}

/**
 * A person, the stamp their sessions are bound to and whether they have a
 * password and a second factor (a passkey or an authenticator app) yet
 * (lib/session.server.ts): one query on every request a cookie signs in.
 */
export async function getUserForSession(id: string): Promise<{
  user: UserRow;
  stamp: string;
  has_password: boolean;
  has_second_factor: boolean;
} | null> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT ${USER_COLUMNS}, stamp, password_hash IS NOT NULL AS has_password,
              (EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = users.id) OR
               EXISTS (SELECT 1 FROM authenticator_apps a WHERE a.user_id = users.id))
                AS has_second_factor
         FROM users WHERE id = $1 LIMIT 1`,
      [id],
    );
    if (r.rows.length === 0) return null;
    return {
      user: mapUserRow(r.rows[0]),
      stamp: String(r.rows[0].stamp),
      has_password: r.rows[0].has_password === true,
      has_second_factor: r.rows[0].has_second_factor === true,
    };
  });
}

/** The person with this Braino name, in any case. */
export async function getUserByUsername(username: string): Promise<UserRow | null> {
  return findUser("lower(username) = lower($1)", username);
}

/** The person who is this GitHub account, for matching GitHub's events. */
export async function getUserByGithubLogin(login: string): Promise<UserRow | null> {
  return findUser("lower(github_login) = lower($1)", login);
}

/** The person who signs in with this address, in any case. */
export async function getUserByEmail(email: string): Promise<UserRow | null> {
  return findUser("lower(email) = lower($1)", email.trim());
}

/** Sets what a person is called; blank clears it, and their username stands in. */
export async function setUserName(id: string, name: string): Promise<void> {
  await withClient((c) =>
    c.query("UPDATE users SET name = NULLIF(btrim($2), ''), updated_at = now() WHERE id = $1", [
      id,
      name,
    ]),
  );
}

/** Makes a person's profile public, so anyone sees it signed out, or private again. */
export async function setUserPublicProfile(id: string, on: boolean): Promise<void> {
  await withClient((c) =>
    c.query("UPDATE users SET public_profile = $2, updated_at = now() WHERE id = $1", [id, on]),
  );
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
      RETURNING ${USER_COLUMNS}`,
      [id, JSON.stringify(patch)],
    );
    if (r.rows.length === 0) return null;
    return mapUserRow(r.rows[0]);
  });
}

export async function listUsers(): Promise<UserRow[]> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT ${USER_COLUMNS} FROM users ORDER BY lower(username) NULLS LAST, id`,
    );
    return r.rows.map(mapUserRow);
  });
}

// ─── Principals (role-personas, node) ───────────────────────────────────
//
// Each collection owns its own role-personas; the same name in two different collections
// is two different rows.

// A Principal is an ordinary node (`node_type = 'principal'`): its name is its
// `prose`, its seat kind is `kind`, and its domain fields (`owner_id`, …) live
// in `extra`. So its readers consume the plain `NodeRow` — no adapter.

export async function getPrincipalById(id: string): Promise<NodeRow | null> {
  return getEntity("principal", id);
}

/**
 * List Principals (role-personas) in a collection, ordered by name (`prose`) then
 * creation, so `find`-by-name lookups in callers are deterministic.
 */
export async function listPrincipals(collectionId: string): Promise<NodeRow[]> {
  const recs = await listNodesByCollection("principal", collectionId);
  return recs.sort((a, b) => {
    const byName = a.prose.localeCompare(b.prose);
    if (byName !== 0) return byName;
    const byTime = (a.created_at ?? "").localeCompare(b.created_at ?? "");
    return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
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
  member_count: number;
}

function mapWorkspaceRow(row: Record<string, unknown>): WorkspaceRow {
  return {
    id: String(row.id),
    handle: String(row.handle),
    name: String(row.name),
    constitution:
      row.constitution === null || row.constitution === undefined ? "" : String(row.constitution),
    member_count: Number(row.member_count),
  };
}

export async function listWorkspaces(): Promise<WorkspaceRow[]> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT o.id, o.handle, o.name, o.constitution,
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
      `SELECT o.id, o.handle, o.name, o.constitution,
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
      `SELECT o.id, o.handle, o.name, o.constitution,
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

export async function upsertWorkspaceUser(opts: {
  workspace_id: string;
  user_id: string;
  role: CollectionRole;
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

export type CollectionRole = "owner" | "writer" | "reader";

export const ROLE_RANK: Record<CollectionRole, number> = {
  owner: 2,
  writer: 1,
  reader: 0,
};

const ROLE_VALUES = new Set<CollectionRole>(["owner", "writer", "reader"]);

function toRole(v: unknown): CollectionRole | null {
  return typeof v === "string" && ROLE_VALUES.has(v as CollectionRole)
    ? (v as CollectionRole)
    : null;
}

export function roleAtLeast(role: CollectionRole | null, threshold: CollectionRole): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[threshold];
}

export function maxRole(...roles: (CollectionRole | null | undefined)[]): CollectionRole | null {
  let best: CollectionRole | null = null;
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
): Promise<CollectionRole | null> {
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
export interface CollectionGrant {
  role: CollectionRole;
  writeTypes: string[];
}

function normalizeGrantWriteTypes(role: CollectionRole, raw: unknown): string[] {
  const writeTypes = normalizeWriteTypes(raw);
  if (role === "owner") return [];
  if (role === "writer" && writeTypes.length === 0) return [WRITE_ALL];
  return writeTypes;
}

export async function getWorkspaceGrant(
  workspaceId: string,
  userId: string,
): Promise<CollectionGrant | null> {
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

export async function getCollectionUserGrant(
  collectionId: string,
  userId: string,
): Promise<CollectionGrant | null> {
  return withClient(async (c) => {
    const r = await c.query<{ role: string; write_types: string[] }>(
      "SELECT role, write_types FROM collection_users WHERE collection_id = $1 AND user_id = $2",
      [collectionId, userId],
    );
    if (r.rowCount === 0) return null;
    const role = toRole(r.rows[0]?.role);
    if (!role) return null;
    return { role, writeTypes: normalizeGrantWriteTypes(role, r.rows[0]?.write_types) };
  });
}

// ─── collection_users ────────────────────────────────────────────────────────────

export interface CollectionUserRow {
  collection_id: string;
  user_id: string;
  role: CollectionRole;
  write_types: string[];
  joined_at: string;
}

export async function getCollectionUserRole(
  collectionId: string,
  userId: string,
): Promise<CollectionRole | null> {
  return withClient(async (c) => {
    const r = await c.query<{ role: string }>(
      "SELECT role FROM collection_users WHERE collection_id = $1 AND user_id = $2",
      [collectionId, userId],
    );
    if (r.rowCount === 0) return null;
    return toRole(r.rows[0]?.role);
  });
}

export async function listCollectionUsers(collectionId: string): Promise<CollectionUserRow[]> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT collection_id, user_id, role, write_types, joined_at FROM collection_users
       WHERE collection_id = $1 ORDER BY joined_at`,
      [collectionId],
    );
    return r.rows.map((row) => {
      const role = toRole(row.role) ?? "reader";
      return {
        collection_id: String(row.collection_id),
        user_id: String(row.user_id),
        role,
        write_types: normalizeGrantWriteTypes(role, row.write_types),
        joined_at:
          row.joined_at instanceof Date ? row.joined_at.toISOString() : String(row.joined_at),
      };
    });
  });
}

export async function listCollectionIdsForUser(userId: string): Promise<string[]> {
  return withClient(async (c) => {
    // Join collections so a tombstoned collection drops out of the member's listing even
    // though its collection_users grant rows are retained for the grace window.
    const r = await c.query<{ collection_id: string }>(
      `SELECT du.collection_id
         FROM collection_users du
         JOIN collections d ON d.id = du.collection_id
        WHERE du.user_id = $1 AND d.deleted_at IS NULL`,
      [userId],
    );
    return r.rows.map((row) => String(row.collection_id));
  });
}

export async function upsertCollectionUser(opts: {
  collection_id: string;
  user_id: string;
  role: CollectionRole;
  /** Per-type write set; defaults to wildcard for writer, empty otherwise. */
  write_types?: string[];
}): Promise<void> {
  const writeTypes = normalizeGrantWriteTypes(opts.role, opts.write_types);
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO collection_users (collection_id, user_id, role, write_types)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (collection_id, user_id)
       DO UPDATE SET role = EXCLUDED.role, write_types = EXCLUDED.write_types`,
      [opts.collection_id, opts.user_id, opts.role, writeTypes],
    );
  });
}

export async function removeCollectionUser(collectionId: string, userId: string): Promise<void> {
  await withClient(async (c) => {
    await c.query("DELETE FROM collection_users WHERE collection_id = $1 AND user_id = $2", [
      collectionId,
      userId,
    ]);
  });
}

// ─── Access requests ────────────────────────────────────────────────────────

/** A request names a collection or a whole workspace, never both. */
export interface AccessRequestRow {
  id: string;
  collection_id: string | null;
  workspace_id: string | null;
  requester_id: string;
  requested_role: CollectionRole;
  reason: string | null;
  status: "pending" | "approved" | "denied" | "cancelled";
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

function mapAccessRequestRow(r: Record<string, unknown>): AccessRequestRow {
  return {
    id: String(r.id),
    collection_id: r.collection_id == null ? null : String(r.collection_id),
    workspace_id: r.workspace_id == null ? null : String(r.workspace_id),
    requester_id: String(r.requester_id),
    requested_role: r.requested_role as CollectionRole,
    reason: r.reason == null ? null : String(r.reason),
    status: r.status as AccessRequestRow["status"],
    created_at: String(r.created_at),
    decided_at: r.decided_at == null ? null : String(r.decided_at),
    decided_by: r.decided_by == null ? null : String(r.decided_by),
  };
}

/**
 * Create (or refresh) the caller's pending access request for a collection or
 * a workspace (exactly one; the table's CHECK holds it). The partial unique
 * indexes permit one live request per (target, requester), so a repeat
 * upserts the role/reason instead of duplicating. Writing the grant on
 * approval is the caller's job (see `decideAccessRequest`).
 */
export async function createAccessRequest(opts: {
  collection_id?: string;
  workspace_id?: string;
  requester_id: string;
  requested_role: CollectionRole;
  reason?: string | null;
}): Promise<AccessRequestRow> {
  const id = `accreq_${randomBytes(16).toString("base64url")}`;
  const target = opts.workspace_id && !opts.collection_id ? "workspace_id" : "collection_id";
  return withClient(async (c) => {
    const r = await c.query(
      `INSERT INTO access_requests (id, collection_id, workspace_id, requester_id, requested_role, reason)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (${target}, requester_id) WHERE status = 'pending'
       DO UPDATE SET requested_role = EXCLUDED.requested_role,
                     reason = EXCLUDED.reason,
                     created_at = now()
       RETURNING *`,
      [
        id,
        opts.collection_id ?? null,
        opts.workspace_id ?? null,
        opts.requester_id,
        opts.requested_role,
        opts.reason ?? null,
      ],
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

/** Pending requests across a set of collections (an owner's inbox), oldest first. */
export async function listPendingAccessRequestsForCollections(
  collectionIds: string[],
): Promise<AccessRequestRow[]> {
  if (collectionIds.length === 0) return [];
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT * FROM access_requests
       WHERE status = 'pending' AND collection_id = ANY($1::text[])
       ORDER BY created_at ASC`,
      [collectionIds],
    );
    return r.rows.map((row) => mapAccessRequestRow(row as Record<string, unknown>));
  });
}

/** Pending requests to join a set of workspaces (their owners' inbox), oldest first. */
export async function listPendingAccessRequestsForWorkspaces(
  workspaceIds: string[],
): Promise<AccessRequestRow[]> {
  if (workspaceIds.length === 0) return [];
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT * FROM access_requests
       WHERE status = 'pending' AND workspace_id = ANY($1::text[])
       ORDER BY created_at ASC`,
      [workspaceIds],
    );
    return r.rows.map((row) => mapAccessRequestRow(row as Record<string, unknown>));
  });
}

/** Pending-request counts for every workspace that has any: the header badge's other half. */
export async function listPendingWorkspaceAccessRequestCounts(): Promise<
  { workspace_id: string; n: number }[]
> {
  return withClient(async (c) => {
    const r = await c.query<{ workspace_id: string; n: number | string }>(
      `SELECT workspace_id, count(*)::int AS n
         FROM access_requests
        WHERE status = 'pending' AND workspace_id IS NOT NULL
        GROUP BY workspace_id`,
    );
    return r.rows.map((row) => ({
      workspace_id: String(row.workspace_id),
      n: typeof row.n === "number" ? row.n : Number(row.n),
    }));
  });
}

/**
 * Pending-request counts for every collection that currently has any — joined to the
 * Collection's `owner_id` so a caller can resolve ownership without an N+1 of
 * `getCollectionById`. The result set is bounded by the (usually tiny) number of
 * Collections with live requests, not by how many a viewer owns; callers filter it
 * down to their own collections. Powers the header's pending-requests badge.
 */
export async function listPendingAccessRequestCountsByCollection(): Promise<
  { collection_id: string; owner_id: string; n: number }[]
> {
  return withClient(async (c) => {
    const r = await c.query<{ collection_id: string; owner_id: string; n: number | string }>(
      `SELECT d.id AS collection_id, d.owner_id, count(*)::int AS n
         FROM access_requests r
         JOIN collections d ON d.id = r.collection_id
        WHERE r.status = 'pending' AND d.deleted_at IS NULL
        GROUP BY d.id, d.owner_id`,
    );
    return r.rows.map((row) => ({
      collection_id: String(row.collection_id),
      owner_id: String(row.owner_id),
      n: typeof row.n === "number" ? row.n : Number(row.n),
    }));
  });
}

/**
 * Flip a pending request to approved/denied. Returns the updated row, or null
 * if it was not pending (already decided or unknown id) — callers treat null
 * as "nothing to do". A pure status transition; on approval the caller writes
 * the grant via `upsertCollectionUser`.
 */
/** Decide a pending request. With `requested_role`, only while the request
 *  still asks for that role: a re-request raises the live row in place, and
 *  an approval binds to the role the owner read. Null when nothing was decided. */
export async function decideAccessRequest(opts: {
  id: string;
  status: "approved" | "denied";
  decided_by: string;
  requested_role?: CollectionRole;
}): Promise<AccessRequestRow | null> {
  return withClient(async (c) => {
    const r = await c.query(
      `UPDATE access_requests
       SET status = $2, decided_at = now(), decided_by = $3
       WHERE id = $1 AND status = 'pending'
         AND ($4::text IS NULL OR requested_role = $4)
       RETURNING *`,
      [opts.id, opts.status, opts.decided_by, opts.requested_role ?? null],
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

// ─── collections ────────────────────────────────────────────────────────────────

export interface CollectionRow {
  id: string;
  handle: string;
  /**
   * Owner label — User.username for human/agent owners,
   * Workspace.handle for workspace owners. Derived via JOIN in `mapCollectionRow`
   * from `owner_id`. NOT a collection identifier.
   */
  owner_slug: string;
  owner_id: string;
  workspace_id: string;
  visibility: "public" | "private";
  goal: string;
  data: Record<string, unknown>;
  /**
   * Template-seeded default lifecycle for new nodes captured into this
   * Collection (e.g. `org-chart` / `glossaries` / `process` ship
   * `drafting`). Null when the collection's template set no default; capture
   * then falls back to each node type's built-in default.
   */
  default_node_lifecycle: string | null;
}

function mapCollectionRow(row: Record<string, unknown>): CollectionRow {
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
 * Resolves `owner_slug` from `users.username` /
 * `workspaces.handle` keyed by `collections.owner_id`.
 */
const COLLECTION_SELECT = `
  SELECT d.id, d.handle, d.owner_id, d.workspace_id, d.visibility, d.goal, d.data,
         d.default_node_lifecycle,
         COALESCE(c.username, o.handle, '') AS owner_slug
    FROM collections d
    LEFT JOIN users c ON c.id = d.owner_id
    LEFT JOIN workspaces o ON o.id = d.owner_id`;

// Tombstoned (soft-deleted) collections are invisible to every resolution and
// listing path — `getCollectionByIdOrHandle` returning null is what makes a deleted
// collection 404 from every route. The only callers that see tombstoned rows are the
// soft-delete write and the purge sweep. The soft-delete frees the original
// handle (see `markCollectionDeleted`), so handle-availability checks need no
// deleted-row special-casing — the original name is simply free. All reads
// here filter `deleted_at`.
export async function listAllCollections(): Promise<CollectionRow[]> {
  return withClient(async (c) => {
    const r = await c.query(`${COLLECTION_SELECT} WHERE d.deleted_at IS NULL ORDER BY d.handle`);
    return r.rows.map(mapCollectionRow);
  });
}

export async function getCollectionById(collectionId: string): Promise<CollectionRow | null> {
  return withClient(async (c) => {
    const r = await c.query(`${COLLECTION_SELECT} WHERE d.id = $1 AND d.deleted_at IS NULL`, [
      collectionId,
    ]);
    return r.rows[0] ? mapCollectionRow(r.rows[0]) : null;
  });
}

export async function getCollectionByHandle(handle: string): Promise<CollectionRow | null> {
  return withClient(async (c) => {
    const r = await c.query(`${COLLECTION_SELECT} WHERE d.handle = $1 AND d.deleted_at IS NULL`, [
      handle,
    ]);
    return r.rows[0] ? mapCollectionRow(r.rows[0]) : null;
  });
}

// Ids carry an uppercase ULID and handles are lowercase, so a value matches one
// or the other; an id's prefix is whatever it was minted with.
export async function getCollectionByIdOrHandle(idOrHandle: string): Promise<CollectionRow | null> {
  return withClient(async (c) => {
    const r = await c.query(
      `${COLLECTION_SELECT} WHERE (d.id = $1 OR d.handle = $1) AND d.deleted_at IS NULL`,
      [idOrHandle],
    );
    return r.rows[0] ? mapCollectionRow(r.rows[0]) : null;
  });
}

/**
 * Soft-delete a collection: stamp `deleted_at` so it vanishes from every read path
 * while its rows are retained for the 30-day grace window. Resolves by id or
 * handle. Idempotent — a collection that is already tombstoned (or absent) returns
 * null. The original handle is freed for immediate reuse: the tombstoned row's
 * handle is rewritten to `<handle>-deleted-<deletion-epoch-millis>` in the same
 * write, so a new collection can claim the original name right away while the
 * tombstone keeps a unique handle of its own. Returns the new (timestamped)
 * handle.
 */
export async function markCollectionDeleted(opts: {
  collectionId?: string;
  handle?: string;
}): Promise<{ id: string; handle: string } | null> {
  // Fixed allowlist — never user input — so it is safe to interpolate.
  const column = opts.collectionId ? "id" : opts.handle ? "handle" : null;
  if (!column) throw new Error("Collection id or handle is required.");
  const value = column === "id" ? opts.collectionId : opts.handle;
  return withClient(async (c) => {
    const r = await c.query<{ id: string; handle: string }>(
      `UPDATE collections
          SET deleted_at = now(),
              updated_at = now(),
              handle     = handle || '-deleted-' || (extract(epoch from now()) * 1000)::bigint::text
        WHERE ${column} = $1 AND deleted_at IS NULL
        RETURNING id, handle`,
      [value],
    );
    const row = r.rows[0];
    return row ? { id: String(row.id), handle: String(row.handle) } : null;
  });
}

/**
 * Hard-delete every collection tombstoned before `cutoff` — the purge sweep behind
 * the 30-day grace window. Reuses the proven `DELETE FROM collections` cascade
 * (ON DELETE CASCADE + the allow-history-delete trigger) so the collection and all
 * its rows — nodes, edges, immutable history, grants — go in one shot. Returns
 * the purged collections for the sweep's audit log.
 */
export async function purgeCollectionsDeletedBefore(
  cutoff: Date,
): Promise<{ id: string; handle: string }[]> {
  return withClient(async (c) => {
    const r = await c.query<{ id: string; handle: string }>(
      `DELETE FROM collections
        WHERE deleted_at IS NOT NULL AND deleted_at < $1
        RETURNING id, handle`,
      [cutoff.toISOString()],
    );
    return r.rows.map((row) => ({ id: String(row.id), handle: String(row.handle) }));
  });
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
  collection_id: string | null;
  workspace_id?: string | null;
  entity_type: string;
  entity_id: string;
  op: string;
  before_json?: Record<string, unknown> | null;
  after_json?: Record<string, unknown> | null;
  reason?: string | null;
}

export async function appendAuditEventRow(
  evt: AuditEventRow,
  client?: pg.PoolClient,
): Promise<void> {
  const append = async (c: pg.PoolClient) => {
    await c.query(
      `INSERT INTO audit_events (event_id, at, by_user, collection_id, workspace_id, entity_type, entity_id, op, before_json, after_json, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        evt.event_id,
        evt.at,
        evt.by_user,
        evt.collection_id,
        evt.workspace_id ?? null,
        evt.entity_type,
        evt.entity_id,
        evt.op,
        evt.before_json ? JSON.stringify(evt.before_json) : null,
        evt.after_json ? JSON.stringify(evt.after_json) : null,
        evt.reason ?? null,
      ],
    );
  };
  if (client) await append(client);
  else await withClient(append);
}

export async function readAuditEventRows(filters: {
  collection_id?: string;
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
  if (filters.collection_id) {
    where.push(`collection_id = $${idx++}`);
    vals.push(filters.collection_id);
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
  const sql = `SELECT event_id, at, by_user, collection_id, workspace_id, entity_type, entity_id, op, before_json, after_json, reason
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
      collection_id: row.collection_id ? String(row.collection_id) : null,
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
