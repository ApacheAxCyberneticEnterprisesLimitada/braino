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
  "doco_id",
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
    doco_id: fields.doco_id ? String(fields.doco_id) : "",
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
  const cols: string[] = ["id", "doco_id", "node_type", "lifecycle", "prose", "extra"];
  const vals: unknown[] = [
    node.id,
    node.doco_id,
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
 * into `nodes` — they are governance config, not graph knowledge. Unlike nodes,
 * a policy keeps its real `policies.data` jsonb (the structured predicate /
 * on_violation / fires_when fields); the standalone `kind` classifier is
 * mirrored to its own column for filtering. `policy.lifecycle` drives the column.
 */
export async function upsertPolicy(policy: PolicyWrite, client?: pg.PoolClient): Promise<void> {
  const cols = ["id", "doco_id", "lifecycle", "data", "kind"];
  const vals: unknown[] = [
    policy.id,
    policy.doco_id,
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
// identity rows (user/doco/workspace) through their own row readers. Every node
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

export async function listNodesByDoco(nodeType: string, docoId: string): Promise<NodeRow[]> {
  return withClient(async (c) => {
    const r = await c.query("SELECT * FROM nodes WHERE doco_id = $1 AND node_type = $2", [
      docoId,
      nodeType,
    ]);
    return r.rows.map(rowToNode);
  });
}

/**
 * Like `listNodesByDoco`, but restricted to the given ids. Used by the
 * incremental reindex path so a one-node capture doesn't drag every
 * row in the Doco off disk just to throw them away.
 */
export async function listNodesByDocoAndIds(
  nodeType: string,
  docoId: string,
  ids: string[],
): Promise<NodeRow[]> {
  if (ids.length === 0) return [];
  return withClient(async (c) => {
    const r = await c.query(
      "SELECT * FROM nodes WHERE doco_id = $1 AND node_type = $2 AND id = ANY($3::text[])",
      [docoId, nodeType, ids],
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
    doco_id: row.doco_id ? String(row.doco_id) : "",
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

// A Principal is an ordinary node (`node_type = 'principal'`): its name is its
// `prose`, its seat kind is `kind`, and its domain fields (`owner_id`, …) live
// in `extra`. So its readers consume the plain `NodeRow` — no adapter.

export async function getPrincipalById(id: string): Promise<NodeRow | null> {
  return getEntity("principal", id);
}

/**
 * List Principals (role-personas) in a Doco, ordered by name (`prose`) then
 * creation, so `find`-by-name lookups in callers are deterministic.
 */
export async function listPrincipals(docoId: string): Promise<NodeRow[]> {
  const recs = await listNodesByDoco("principal", docoId);
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
    // Join docos so a tombstoned Doco drops out of the member's listing even
    // though its doco_users grant rows are retained for the grace window.
    const r = await c.query<{ doco_id: string }>(
      `SELECT du.doco_id
         FROM doco_users du
         JOIN docos d ON d.id = du.doco_id
        WHERE du.user_id = $1 AND d.deleted_at IS NULL`,
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
 * Pending-request counts for every Doco that currently has any — joined to the
 * Doco's `owner_id` so a caller can resolve ownership without an N+1 of
 * `getDocoById`. The result set is bounded by the (usually tiny) number of
 * Docos with live requests, not by how many a viewer owns; callers filter it
 * down to their own Docos. Powers the header's pending-requests badge.
 */
export async function listPendingAccessRequestCountsByDoco(): Promise<
  { doco_id: string; owner_id: string; n: number }[]
> {
  return withClient(async (c) => {
    const r = await c.query<{ doco_id: string; owner_id: string; n: number | string }>(
      `SELECT d.id AS doco_id, d.owner_id, count(*)::int AS n
         FROM access_requests r
         JOIN docos d ON d.id = r.doco_id
        WHERE r.status = 'pending' AND d.deleted_at IS NULL
        GROUP BY d.id, d.owner_id`,
    );
    return r.rows.map((row) => ({
      doco_id: String(row.doco_id),
      owner_id: String(row.owner_id),
      n: typeof row.n === "number" ? row.n : Number(row.n),
    }));
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
   * Doco (e.g. `org-chart` / `glossaries` / `process` ship
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

// Tombstoned (soft-deleted) Docos are invisible to every resolution and
// listing path — `getDocoByIdOrHandle` returning null is what makes a deleted
// Doco 404 from every route. The only callers that see tombstoned rows are the
// soft-delete write and the purge sweep. The soft-delete frees the original
// handle (see `markDocoDeleted`), so handle-availability checks need no
// deleted-row special-casing — the original name is simply free. All reads
// here filter `deleted_at`.
export async function listAllDocos(): Promise<DocoRow[]> {
  return withClient(async (c) => {
    const r = await c.query(`${DOCO_SELECT} WHERE d.deleted_at IS NULL ORDER BY d.handle`);
    return r.rows.map(mapDocoRow);
  });
}

export async function getDocoById(docoId: string): Promise<DocoRow | null> {
  return withClient(async (c) => {
    const r = await c.query(`${DOCO_SELECT} WHERE d.id = $1 AND d.deleted_at IS NULL`, [docoId]);
    return r.rows[0] ? mapDocoRow(r.rows[0]) : null;
  });
}

export async function getDocoByHandle(handle: string): Promise<DocoRow | null> {
  return withClient(async (c) => {
    const r = await c.query(`${DOCO_SELECT} WHERE d.handle = $1 AND d.deleted_at IS NULL`, [
      handle,
    ]);
    return r.rows[0] ? mapDocoRow(r.rows[0]) : null;
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
 * Soft-delete a Doco: stamp `deleted_at` so it vanishes from every read path
 * while its rows are retained for the 30-day grace window. Resolves by id or
 * handle. Idempotent — a Doco that is already tombstoned (or absent) returns
 * null. The original handle is freed for immediate reuse: the tombstoned row's
 * handle is rewritten to `<handle>-deleted-<deletion-epoch-millis>` in the same
 * write, so a new Doco can claim the original name right away while the
 * tombstone keeps a unique handle of its own. Returns the new (timestamped)
 * handle.
 */
export async function markDocoDeleted(opts: {
  docoId?: string;
  handle?: string;
}): Promise<{ id: string; handle: string } | null> {
  // Fixed allowlist — never user input — so it is safe to interpolate.
  const column = opts.docoId ? "id" : opts.handle ? "handle" : null;
  if (!column) throw new Error("Doco id or handle is required.");
  const value = column === "id" ? opts.docoId : opts.handle;
  return withClient(async (c) => {
    const r = await c.query<{ id: string; handle: string }>(
      `UPDATE docos
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
 * Hard-delete every Doco tombstoned before `cutoff` — the purge sweep behind
 * the 30-day grace window. Reuses the proven `DELETE FROM docos` cascade
 * (ON DELETE CASCADE + the allow-history-delete trigger) so the Doco and all
 * its rows — nodes, edges, immutable history, grants — go in one shot. Returns
 * the purged Docos for the sweep's audit log.
 */
export async function purgeDocosDeletedBefore(
  cutoff: Date,
): Promise<{ id: string; handle: string }[]> {
  return withClient(async (c) => {
    const r = await c.query<{ id: string; handle: string }>(
      `DELETE FROM docos
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
