// CRUD helpers for entity rows. Generic across node types via NODE_TABLES.

import type pg from "pg";
import { NODE_TABLES, type EntityRecord } from "./types.js";
import { withClient } from "./client.js";

function tableFor(nodeType: string): { table: string; body: boolean } {
  const spec = NODE_TABLES[nodeType];
  if (!spec) throw new Error(`Unknown node type for storage: ${nodeType}`);
  return spec;
}

/**
 * Upsert one entity. Identity tables (principals/organizations/docos)
 * have richer columns and use their own writers — the generic path
 * here covers Doco entity types.
 */
export async function upsertEntity(rec: EntityRecord, client?: pg.PoolClient): Promise<void> {
  const spec = tableFor(rec.node_type);
  if (rec.node_type === "principal" || rec.node_type === "organization" || rec.node_type === "doco") {
    return upsertIdentity(rec, client);
  }
  const cols = ["id", "doco_id", "summary", "lifecycle", "raw_yaml"];
  const vals: unknown[] = [rec.id, rec.doco_id, rec.summary ?? null, rec.lifecycle ?? null, rec.raw_yaml];
  if (spec.body) {
    cols.push("body_md");
    vals.push(rec.body_md ?? null);
  }
  if (rec.node_type === "scope") {
    cols.push("name");
    vals.push(rec.name ?? null);
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

async function upsertIdentity(rec: EntityRecord, client?: pg.PoolClient): Promise<void> {
  const yamlObj = JSON.parse(rec.raw_yaml.startsWith("{") ? rec.raw_yaml : "{}") as Record<
    string,
    unknown
  >;
  const run = async (c: pg.PoolClient) => {
    if (rec.node_type === "principal") {
      const username = String(yamlObj.username ?? rec.id);
      const type = String(yamlObj.type ?? "human");
      const display_name = (yamlObj.display_name as string | null) ?? null;
      const email = (yamlObj.email as string | null) ?? null;
      const github_login = (yamlObj.github_login as string | null) ?? null;
      const avatar_url = (yamlObj.avatar_url as string | null) ?? null;
      const owner_id = (yamlObj.owner_id as string | null) ?? null;
      const deactivated_at = (yamlObj.deactivated_at as string | null) ?? null;
      await c.query(
        `INSERT INTO principals (id, username, type, display_name, email, github_login, avatar_url, owner_id, raw_yaml, deactivated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET username=EXCLUDED.username, type=EXCLUDED.type,
           display_name=EXCLUDED.display_name, email=EXCLUDED.email, github_login=EXCLUDED.github_login,
           avatar_url=EXCLUDED.avatar_url, owner_id=EXCLUDED.owner_id, raw_yaml=EXCLUDED.raw_yaml,
           deactivated_at=EXCLUDED.deactivated_at, updated_at=now()`,
        [rec.id, username, type, display_name, email, github_login, avatar_url, owner_id, rec.raw_yaml, deactivated_at],
      );
    } else if (rec.node_type === "organization") {
      const slug = String(yamlObj.slug ?? rec.id);
      const name = String(yamlObj.name ?? slug);
      await c.query(
        `INSERT INTO organizations (id, slug, name, raw_yaml) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET slug=EXCLUDED.slug, name=EXCLUDED.name,
           raw_yaml=EXCLUDED.raw_yaml, updated_at=now()`,
        [rec.id, slug, name, rec.raw_yaml],
      );
    } else if (rec.node_type === "doco") {
      const owner_id = String(yamlObj.owner_id ?? "");
      const handle = String(yamlObj.handle ?? "");
      if (!handle) {
        throw new Error(
          `Cannot upsert doco ${rec.id}: yaml is missing the required \`handle\` field.`,
        );
      }
      const name = (yamlObj.name as string | null) ?? (yamlObj.display_name as string | null) ?? null;
      const visibility = String(yamlObj.visibility ?? "private");
      await c.query(
        `INSERT INTO docos (id, handle, owner_id, name, visibility, raw_yaml)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET handle=EXCLUDED.handle,
           owner_id=EXCLUDED.owner_id, name=EXCLUDED.name,
           visibility=EXCLUDED.visibility, raw_yaml=EXCLUDED.raw_yaml, updated_at=now()`,
        [rec.id, handle, owner_id, name, visibility, rec.raw_yaml],
      );
    }
  };
  if (client) {
    await run(client);
  } else {
    await withClient(run);
  }
}

export async function getEntity(
  nodeType: string,
  id: string,
): Promise<EntityRecord | null> {
  const spec = tableFor(nodeType);
  return withClient(async (c) => {
    const r = await c.query(`SELECT * FROM ${spec.table} WHERE id = $1`, [id]);
    if (r.rowCount === 0) return null;
    return rowToRecord(nodeType, r.rows[0]);
  });
}

export async function listEntitiesByDoco(
  nodeType: string,
  docoId: string,
): Promise<EntityRecord[]> {
  const spec = tableFor(nodeType);
  return withClient(async (c) => {
    const r = await c.query(`SELECT * FROM ${spec.table} WHERE doco_id = $1`, [docoId]);
    return r.rows.map((row) => rowToRecord(nodeType, row));
  });
}

export async function listIdentityRows(
  nodeType: "principal" | "organization" | "doco",
): Promise<EntityRecord[]> {
  const spec = tableFor(nodeType);
  return withClient(async (c) => {
    const r = await c.query(`SELECT * FROM ${spec.table}`);
    return r.rows.map((row) => rowToRecord(nodeType, row));
  });
}

function rowToRecord(nodeType: string, row: Record<string, unknown>): EntityRecord {
  const rec: EntityRecord = {
    id: String(row.id),
    doco_id: row.doco_id ? String(row.doco_id) : "",
    node_type: nodeType,
    raw_yaml: String(row.raw_yaml),
  };
  if ("body_md" in row && row.body_md !== null) rec.body_md = String(row.body_md);
  if ("summary" in row && row.summary !== null) rec.summary = String(row.summary);
  if ("lifecycle" in row && row.lifecycle !== null) rec.lifecycle = String(row.lifecycle);
  if ("name" in row && row.name !== null) rec.name = String(row.name);
  if (row.created_at instanceof Date) rec.created_at = row.created_at.toISOString();
  if ("created_by" in row && row.created_by !== null) rec.created_by = String(row.created_by);
  if (row.updated_at instanceof Date) rec.updated_at = row.updated_at.toISOString();
  if ("updated_by" in row && row.updated_by !== null) rec.updated_by = String(row.updated_by);
  return rec;
}


/** Find a Doco by its `handle` and return its (ULID) id. */
export async function resolveDocoIdByHandle(handle: string): Promise<string | null> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT id FROM docos WHERE handle = $1`,
      [handle],
    );
    if (r.rowCount === 0) return null;
    return String(r.rows[0].id);
  });
}

// ─── Host + identity queries (Phase 3 — replace FS reads) ──────────────────

export interface HostConfigRow {
  id: string;
  name: string;
  visibility: "public" | "private";
  raw_yaml: string;
}

export async function getHostConfig(): Promise<HostConfigRow | null> {
  return withClient(async (c) => {
    const r = await c.query("SELECT id, name, visibility, raw_yaml FROM hosts LIMIT 1");
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    return {
      id: String(row.id),
      name: String(row.name),
      visibility: row.visibility === "public" ? "public" : "private",
      raw_yaml: String(row.raw_yaml),
    };
  });
}

export async function upsertHostConfig(opts: {
  id: string;
  name: string;
  visibility: "public" | "private";
  raw_yaml: string;
}): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO hosts (id, name, visibility, raw_yaml)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, visibility=EXCLUDED.visibility,
         raw_yaml=EXCLUDED.raw_yaml, updated_at=now()`,
      [opts.id, opts.name, opts.visibility, opts.raw_yaml],
    );
  });
}

export interface PrincipalRow {
  id: string;
  username: string;
  type: string;
  display_name: string | null;
  email: string | null;
  github_login: string | null;
  raw_yaml: string;
}

function mapPrincipalRow(row: Record<string, unknown>): PrincipalRow {
  return {
    id: String(row.id),
    username: String(row.username),
    type: String(row.type),
    display_name: row.display_name === null || row.display_name === undefined ? null : String(row.display_name),
    email: row.email === null || row.email === undefined ? null : String(row.email),
    github_login: row.github_login === null || row.github_login === undefined ? null : String(row.github_login),
    raw_yaml: String(row.raw_yaml),
  };
}

export async function getPrincipalById(id: string): Promise<PrincipalRow | null> {
  return withClient(async (c) => {
    const r = await c.query(
      "SELECT id, username, type, display_name, email, github_login, raw_yaml FROM principals WHERE id = $1",
      [id],
    );
    if (r.rowCount === 0) return null;
    return mapPrincipalRow(r.rows[0]);
  });
}

export async function getPrincipalByUsername(username: string): Promise<PrincipalRow | null> {
  return withClient(async (c) => {
    const r = await c.query(
      "SELECT id, username, type, display_name, email, github_login, raw_yaml FROM principals WHERE username = $1",
      [username],
    );
    if (r.rowCount === 0) return null;
    return mapPrincipalRow(r.rows[0]);
  });
}

/**
 * List Principals of a given type. `bootstrap_placeholder: true` rows
 * (per ADR-073) are filtered out of all listings — they exist only to
 * own host-bootstrap docos and are never user-facing.
 */
export async function listPrincipals(opts: { type?: string } = {}): Promise<PrincipalRow[]> {
  return withClient(async (c) => {
    const conds: string[] = ["(raw_yaml::jsonb->>'bootstrap_placeholder' IS NULL OR raw_yaml::jsonb->>'bootstrap_placeholder' != 'true')"];
    const vals: unknown[] = [];
    if (opts.type) {
      vals.push(opts.type);
      conds.push(`type = $${vals.length}`);
    }
    const r = await c.query(
      `SELECT id, username, type, display_name, email, github_login, raw_yaml
       FROM principals WHERE ${conds.join(" AND ")} ORDER BY username`,
      vals,
    );
    return r.rows.map(mapPrincipalRow);
  });
}

export interface OrganizationRow {
  id: string;
  slug: string;
  name: string;
  raw_yaml: string;
  member_count: number;
}

export async function listOrganizations(): Promise<OrganizationRow[]> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT o.id, o.slug, o.name, o.raw_yaml,
              COALESCE((SELECT count(*) FROM org_users m WHERE m.org_id = o.id), 0) AS member_count
       FROM organizations o ORDER BY o.slug`,
    );
    return r.rows.map((row) => ({
      id: String(row.id),
      slug: String(row.slug),
      name: String(row.name),
      raw_yaml: String(row.raw_yaml),
      member_count: Number(row.member_count),
    }));
  });
}

export async function listOrganizationsForPrincipal(
  principalId: string,
  roles: string[] = ["owner", "approver", "author", "reader"],
): Promise<OrganizationRow[]> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT o.id, o.slug, o.name, o.raw_yaml,
              COALESCE((SELECT count(*) FROM org_users m WHERE m.org_id = o.id), 0) AS member_count
       FROM organizations o
       JOIN org_users m ON m.org_id = o.id
       WHERE m.principal_id = $1 AND m.role = ANY($2)
       ORDER BY o.slug`,
      [principalId, roles],
    );
    return r.rows.map((row) => ({
      id: String(row.id),
      slug: String(row.slug),
      name: String(row.name),
      raw_yaml: String(row.raw_yaml),
      member_count: Number(row.member_count),
    }));
  });
}

export async function isOrgUser(orgId: string, principalId: string): Promise<boolean> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT 1 FROM org_users WHERE org_id = $1 AND principal_id = $2`,
      [orgId, principalId],
    );
    return r.rowCount !== null && r.rowCount > 0;
  });
}

/**
 * "Has admin-tier rights on the org." Post-cutover
 * (decision_01KS0JBJ5X0AZ4XJJFKEWE1R62), admin-tier collapses onto the new
 * `owner` role; legacy 'admin'/'member' rows backfill to 'owner' so the
 * behavior is unchanged for existing data.
 */
export async function isOrgAdmin(orgId: string, principalId: string): Promise<boolean> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT 1 FROM org_users WHERE org_id = $1 AND principal_id = $2 AND role = 'owner'`,
      [orgId, principalId],
    );
    return r.rowCount !== null && r.rowCount > 0;
  });
}

export async function upsertOrgUser(opts: {
  org_id: string;
  principal_id: string;
  role: DocoRole;
}): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO org_users (org_id, principal_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (org_id, principal_id) DO UPDATE SET role=EXCLUDED.role`,
      [opts.org_id, opts.principal_id, opts.role],
    );
  });
}

export async function removeOrgUser(orgId: string, principalId: string): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `DELETE FROM org_users WHERE org_id = $1 AND principal_id = $2`,
      [orgId, principalId],
    );
  });
}

// ─── Role primitives (decision_01KS0JBJ5X0AZ4XJJFKEWE1R62) ─────────────────

export type DocoRole = "owner" | "approver" | "author" | "reader";

/** Role precedence. Higher rank = more privilege. */
export const ROLE_RANK: Record<DocoRole, number> = {
  owner: 3,
  approver: 2,
  author: 1,
  reader: 0,
};

const ROLE_VALUES = new Set<DocoRole>(["owner", "approver", "author", "reader"]);

function toRole(v: unknown): DocoRole | null {
  return typeof v === "string" && ROLE_VALUES.has(v as DocoRole) ? (v as DocoRole) : null;
}

/** True iff `role` is at least as privileged as `threshold`. Null = no grant. */
export function roleAtLeast(role: DocoRole | null, threshold: DocoRole): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[threshold];
}

/** Highest-privilege role across all inputs. Null if no input has a role. */
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

/** Lookup the principal's row on an org, returning its role (or null). */
export async function getOrgRole(orgId: string, principalId: string): Promise<DocoRole | null> {
  return withClient(async (c) => {
    const r = await c.query<{ role: string }>(
      `SELECT role FROM org_users WHERE org_id = $1 AND principal_id = $2`,
      [orgId, principalId],
    );
    if (r.rowCount === 0) return null;
    return toRole(r.rows[0]?.role);
  });
}

// ─── doco_users ────────────────────────────────────────────────────────────

export interface DocoUserRow {
  doco_id: string;
  principal_id: string;
  role: DocoRole;
  joined_at: string;
}

export async function getDocoUserRole(
  docoId: string,
  principalId: string,
): Promise<DocoRole | null> {
  return withClient(async (c) => {
    const r = await c.query<{ role: string }>(
      `SELECT role FROM doco_users WHERE doco_id = $1 AND principal_id = $2`,
      [docoId, principalId],
    );
    if (r.rowCount === 0) return null;
    return toRole(r.rows[0]?.role);
  });
}

export async function listDocoUsers(docoId: string): Promise<DocoUserRow[]> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT doco_id, principal_id, role, joined_at FROM doco_users
       WHERE doco_id = $1 ORDER BY joined_at`,
      [docoId],
    );
    return r.rows.map((row) => ({
      doco_id: String(row.doco_id),
      principal_id: String(row.principal_id),
      role: (toRole(row.role) ?? "reader") as DocoRole,
      joined_at: row.joined_at instanceof Date
        ? row.joined_at.toISOString()
        : String(row.joined_at),
    }));
  });
}

export async function listDocoIdsForUserPrincipal(
  principalId: string,
): Promise<string[]> {
  return withClient(async (c) => {
    const r = await c.query<{ doco_id: string }>(
      `SELECT doco_id FROM doco_users WHERE principal_id = $1`,
      [principalId],
    );
    return r.rows.map((row) => String(row.doco_id));
  });
}

export async function upsertDocoUser(opts: {
  doco_id: string;
  principal_id: string;
  role: DocoRole;
}): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO doco_users (doco_id, principal_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (doco_id, principal_id) DO UPDATE SET role = EXCLUDED.role`,
      [opts.doco_id, opts.principal_id, opts.role],
    );
  });
}

export async function removeDocoUser(docoId: string, principalId: string): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `DELETE FROM doco_users WHERE doco_id = $1 AND principal_id = $2`,
      [docoId, principalId],
    );
  });
}

// ─── scope_users ───────────────────────────────────────────────────────────

export interface ScopeUserRow {
  scope_id: string;
  principal_id: string;
  role: DocoRole;
  joined_at: string;
}

export async function getScopeUserRole(
  scopeId: string,
  principalId: string,
): Promise<DocoRole | null> {
  return withClient(async (c) => {
    const r = await c.query<{ role: string }>(
      `SELECT role FROM scope_users WHERE scope_id = $1 AND principal_id = $2`,
      [scopeId, principalId],
    );
    if (r.rowCount === 0) return null;
    return toRole(r.rows[0]?.role);
  });
}

export async function listScopeUsers(scopeId: string): Promise<ScopeUserRow[]> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT scope_id, principal_id, role, joined_at FROM scope_users
       WHERE scope_id = $1 ORDER BY joined_at`,
      [scopeId],
    );
    return r.rows.map((row) => ({
      scope_id: String(row.scope_id),
      principal_id: String(row.principal_id),
      role: (toRole(row.role) ?? "reader") as DocoRole,
      joined_at: row.joined_at instanceof Date
        ? row.joined_at.toISOString()
        : String(row.joined_at),
    }));
  });
}

/** Any scope id in `docoId` where `principalId` has an explicit scope grant. */
export async function listScopeIdsWithGrant(
  docoId: string,
  principalId: string,
): Promise<string[]> {
  return withClient(async (c) => {
    const r = await c.query<{ scope_id: string }>(
      `SELECT m.scope_id FROM scope_users m
       JOIN scopes s ON s.id = m.scope_id
       WHERE s.doco_id = $1 AND m.principal_id = $2`,
      [docoId, principalId],
    );
    return r.rows.map((row) => String(row.scope_id));
  });
}

/** Every scope id where `principalId` has an explicit scope_users row, across all docos. */
export async function listScopeIdsForUserPrincipal(principalId: string): Promise<string[]> {
  return withClient(async (c) => {
    const r = await c.query<{ scope_id: string }>(
      `SELECT scope_id FROM scope_users WHERE principal_id = $1`,
      [principalId],
    );
    return r.rows.map((row) => String(row.scope_id));
  });
}

export async function upsertScopeUser(opts: {
  scope_id: string;
  principal_id: string;
  role: DocoRole;
}): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO scope_users (scope_id, principal_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (scope_id, principal_id) DO UPDATE SET role = EXCLUDED.role`,
      [opts.scope_id, opts.principal_id, opts.role],
    );
  });
}

export async function removeScopeUser(scopeId: string, principalId: string): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `DELETE FROM scope_users WHERE scope_id = $1 AND principal_id = $2`,
      [scopeId, principalId],
    );
  });
}

export interface DocoRow {
  /** Internal ULID — every entity table FKs to this. Never user-visible. */
  id: string;
  /** Public, globally-unique URL identifier. */
  handle: string;
  /**
   * Owner's identifier-as-a-slug — Principal.username for human/agent
   * owners, Organization.slug for org owners. Derived via JOIN in
   * `mapDocoRow` from `owner_id`. Useful for "owned by alice" labels.
   * NOT a doco identifier.
   */
  owner_slug: string;
  owner_id: string;
  name: string | null;
  visibility: "public" | "private";
  raw_yaml: string;
}

function mapDocoRow(row: Record<string, unknown>): DocoRow {
  return {
    id: String(row.id),
    handle: String(row.handle ?? ""),
    owner_slug: String(row.owner_slug ?? ""),
    owner_id: String(row.owner_id),
    name: row.name === null || row.name === undefined ? null : String(row.name),
    visibility: row.visibility === "public" ? "public" : "private",
    raw_yaml: String(row.raw_yaml),
  };
}

/**
 * Common SELECT fragment for the `getDoco*` readers. The LEFT JOIN
 * resolves `owner_slug` from `principals.username` /
 * `organizations.slug` keyed by `docos.owner_id` (the doco itself no
 * longer carries a slug column — phase 3a dropped it).
 */
const DOCO_SELECT = `
  SELECT d.id, d.handle, d.owner_id, d.name, d.visibility, d.raw_yaml,
         COALESCE(p.username, o.slug, '') AS owner_slug
    FROM docos d
    LEFT JOIN principals p ON p.id = d.owner_id
    LEFT JOIN organizations o ON o.id = d.owner_id`;

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

/** Resolve a Doco by its handle (public URL id) or internal ULID. */
export async function getDocoByIdOrHandle(idOrHandle: string): Promise<DocoRow | null> {
  if (idOrHandle.startsWith("doco_")) {
    const byId = await getDocoById(idOrHandle);
    if (byId) return byId;
  }
  return getDocoByHandle(idOrHandle);
}

/**
 * Resolve a top-level slug to either a Principal (by username) or an
 * Organization (by slug). Used by the owner-profile route to render
 * `/<owner>` for either kind.
 */
export async function resolveOwnerSlug(
  slug: string,
): Promise<{ kind: "principal"; principal: PrincipalRow } | { kind: "organization"; org: OrganizationRow } | null> {
  const p = await getPrincipalByUsername(slug);
  if (p) return { kind: "principal", principal: p };
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT id, slug, name, raw_yaml,
              COALESCE((SELECT count(*) FROM org_users m WHERE m.org_id = organizations.id), 0) AS member_count
       FROM organizations WHERE slug = $1`,
      [slug],
    );
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    return {
      kind: "organization" as const,
      org: {
        id: String(row.id),
        slug: String(row.slug),
        name: String(row.name),
        raw_yaml: String(row.raw_yaml),
        member_count: Number(row.member_count),
      },
    };
  });
}

export interface AuditEventRow {
  event_id: string;
  at: string;
  by_principal: string | null;
  doco_id: string;
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
      `INSERT INTO audit_events (event_id, at, by_principal, doco_id, entity_type, entity_id, op, before_json, after_json, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        evt.event_id,
        evt.at,
        evt.by_principal,
        evt.doco_id,
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
  entity_id?: string;
  entity_type?: string;
  op?: string[];
  by?: string;
  since?: string;
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
    where.push(`by_principal = $${idx++}`);
    vals.push(filters.by);
  }
  if (filters.since) {
    where.push(`at >= $${idx++}`);
    vals.push(filters.since);
  }
  if (filters.until) {
    where.push(`at <= $${idx++}`);
    vals.push(filters.until);
  }
  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 1000);
  const sql = `SELECT event_id, at, by_principal, doco_id, entity_type, entity_id, op, before_json, after_json, reason
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
      by_principal: row.by_principal ? String(row.by_principal) : null,
      doco_id: String(row.doco_id),
      entity_type: String(row.entity_type),
      entity_id: String(row.entity_id),
      op: String(row.op),
      before_json: row.before_json ?? null,
      after_json: row.after_json ?? null,
      reason: row.reason ?? null,
    }));
  });
}
