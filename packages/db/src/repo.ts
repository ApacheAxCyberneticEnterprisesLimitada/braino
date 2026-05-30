// CRUD helpers for entity rows. Generic across categories via the maps
// in `./types.js`.
//
// Post-migration-005:
//   * `principals` table is SLIMMED — role-personas only, no OAuth fields.
//   * `users` is a NEW table — OAuth identity (person or agent).
//   * Membership + OAuth tables reference `user_id` (was `principal_id`).
//   * `docos.owner_id` is polymorphic: `user_<ulid>` or `organization_<ulid>`.

import { normalizeWriteTypes } from "@doco/shared";
import type pg from "pg";
import { withClient } from "./client.js";
import { ALL_ENTITY_TABLES, type EntityRecord } from "./types.js";

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
 * Drop the legacy prose keys from a migrated node's `data` jsonb
 * before persisting. The merged content already lives in the
 * type-named column; keeping a stale copy in `data` would diverge on
 * subsequent updates and leak into JSON API responses.
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
 * Upsert one entity. Identity tables (principals/organizations/docos/
 * users) have richer columns and use their own writers — the
 * generic path here covers Doco entity types.
 */
export async function upsertEntity(rec: EntityRecord, client?: pg.PoolClient): Promise<void> {
  const spec = tableFor(rec.entity_type);
  if (
    rec.entity_type === "principal" ||
    rec.entity_type === "organization" ||
    rec.entity_type === "doco" ||
    rec.entity_type === "user"
  ) {
    return upsertIdentity(rec, client);
  }
  // Migrated nodes store prose in a single type-named column
  // (intents.intent, decisions.decision, …); the legacy `summary`,
  // `body_md`, `title`, `name`, and `description` keys were dropped by
  // migration 023 and must not leak back into `data` jsonb either.
  // Policies (the only non-migrated entity type reaching this branch
  // — principals go through upsertIdentity) carry their one-line rule
  // in the `policy` column (renamed from `summary` by migration 038)
  // plus an optional `body_md`.
  // Strip prose-collapsed keys (migration 023) and promoted-scalar keys
  // (migration 035) from the jsonb bag so the typed columns are the
  // single source of truth and the two surfaces can never drift.
  const baseData = spec.typeNamedColumn ? stripLegacyProseKeys(rec.data) : rec.data;
  const cleanData = stripPromotedKeys(rec.entity_type, baseData);
  // Single source of truth for lifecycle: `data.lifecycle`. The column
  // is a denormalized mirror used for filtering/indexing — derive it
  // from `data` instead of trusting the caller-supplied `rec.lifecycle`
  // so the two can never drift. Warn if the caller passed a value that
  // disagrees, since that signals a bug at the call site.
  const lifecycleCol = deriveLifecycleColumn(rec, cleanData);
  const cols = ["id", "doco_id", "lifecycle", "data"];
  const vals: unknown[] = [rec.id, rec.doco_id, lifecycleCol, JSON.stringify(cleanData)];
  if (spec.typeNamedColumn) {
    cols.push(spec.typeNamedColumn);
    vals.push(rec.type_named_value ?? "");
  } else {
    // Policies — `policy` column holds the one-line rule.
    cols.push("policy");
    vals.push(typeof rec.data.policy === "string" ? rec.data.policy : "");
    if (spec.body) {
      cols.push("body_md");
      vals.push(rec.body_md ?? null);
    }
  }
  // Promoted FK columns (real foreign keys). Extract from rec.data so
  // captures land typed-column values on the way in — the edges
  // table still materializes via deriveEdges for the array-shaped
  // refs (intent_ids, decision_ids, …).
  for (const [col, source] of fkColumnSources(rec.entity_type, rec.data)) {
    cols.push(col);
    vals.push(source);
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
 * Map an entity's frontmatter to the typed column values added by
 * migrations 013 (FKs) and 035 (scalars). Returns [columnName, value]
 * pairs to splice into the INSERT/UPSERT. Polymorphic refs (target,
 * target_ref, born_from) and arrays (intent_ids, decision_ids) are
 * excluded — those stay in the data jsonb bag, materialized into
 * edges by the indexer.
 */
function fkColumnSources(
  entityType: string,
  fm: Record<string, unknown>,
): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  const stringOrNull = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  switch (entityType) {
    case "intent":
      out.push(["parent_intent_id", stringOrNull(fm.parent_intent_id)]);
      break;
    case "idea":
      out.push(["proposer_id", stringOrNull(fm.proposer_id)]);
      break;
    case "decision": {
      out.push(["decided_by", stringOrNull(fm.decided_by)]);
      // superseded_by in frontmatter is polymorphic; only persist when
      // it looks like a decision id so the FK constraint holds.
      const sb = stringOrNull(fm.superseded_by);
      out.push(["superseded_by_decision_id", sb?.startsWith("decision_") ? sb : null]);
      break;
    }
    case "action":
      out.push(["actor_id", stringOrNull(fm.actor_id)]);
      // Scalars promoted by migration 035.
      out.push(["verb", stringOrNull(fm.verb)]);
      out.push(["performed_at", stringOrNull(fm.performed_at)]);
      break;
    case "log":
      out.push(["actor_id", stringOrNull(fm.actor_id)]);
      out.push(["template_id", stringOrNull(fm.template_id)]);
      // Scalars promoted by migration 035.
      out.push(["verb", stringOrNull(fm.verb)]);
      out.push(["happened_at", stringOrNull(fm.happened_at)]);
      break;
    case "eval":
      // Scalar promoted by migration 035.
      out.push(["kind", stringOrNull(fm.kind)]);
      break;
    case "rule":
      // Scalars promoted by migration 035 — predicate/expected/applies_to
      // stay in data jsonb because they're compound.
      out.push(["kind", stringOrNull(fm.kind)]);
      out.push(["modality", stringOrNull(fm.modality)]);
      out.push(["severity", stringOrNull(fm.severity)]);
      out.push(["phase", stringOrNull(fm.phase)]);
      out.push(["on_violation", stringOrNull(fm.on_violation)]);
      break;
    case "state":
      // Scalar promoted by migration 035.
      out.push(["kind", stringOrNull(fm.kind)]);
      break;
    case "reference":
      // Scalars promoted by migration 035.
      out.push(["ref_type", stringOrNull(fm.ref_type)]);
      out.push(["locator", stringOrNull(fm.locator)]);
      out.push(["citation", stringOrNull(fm.citation)]);
      out.push(["title", stringOrNull(fm.title)]);
      break;
  }
  return out;
}

/**
 * Keys that have been promoted to typed columns and must not also
 * live in the `data` jsonb. Keeps the jsonb tight and prevents the
 * two surfaces from drifting on update.
 */
const PROMOTED_DATA_KEYS_BY_TYPE: Record<string, ReadonlySet<string>> = {
  action: new Set(["verb", "performed_at"]),
  log: new Set(["verb", "happened_at"]),
  eval: new Set(["kind"]),
  rule: new Set(["kind", "modality", "severity", "phase", "on_violation"]),
  state: new Set(["kind"]),
  reference: new Set(["ref_type", "locator", "citation", "title"]),
  principal: new Set(["role_principal"]),
};

function stripPromotedKeys(
  entityType: string,
  fm: Record<string, unknown>,
): Record<string, unknown> {
  const promoted = PROMOTED_DATA_KEYS_BY_TYPE[entityType];
  if (!promoted) return fm;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (!promoted.has(k)) out[k] = v;
  }
  return out;
}

async function upsertIdentity(rec: EntityRecord, client?: pg.PoolClient): Promise<void> {
  const fields = rec.data;
  const run = async (c: pg.PoolClient) => {
    if (rec.entity_type === "principal") {
      const name = String(fields.name ?? rec.id);
      // Same drift-prevention as upsertEntity: principals' lifecycle
      // column mirrors data.lifecycle.
      const lifecycleCol = deriveLifecycleColumn(rec, fields);
      // Promoted scalar (migration 035): role_principal lives on its
      // own column and the key is stripped from the data jsonb so the
      // column is the single source of truth.
      const rolePrincipal = Boolean(fields.role_principal);
      const cleanedFields = stripPromotedKeys(rec.entity_type, fields);
      const dataJson = JSON.stringify(cleanedFields);
      await c.query(
        // `summary` column dropped by migration 037. Principal carries
        // `name` (display label) + `body_md` (everything else).
        `INSERT INTO principals (id, name, doco_id, lifecycle, body_md, role_principal, data,
                                  created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,
           doco_id=EXCLUDED.doco_id, lifecycle=EXCLUDED.lifecycle,
           body_md=EXCLUDED.body_md, role_principal=EXCLUDED.role_principal, data=EXCLUDED.data,
           updated_at=EXCLUDED.updated_at, updated_by=EXCLUDED.updated_by`,
        [
          rec.id,
          name,
          rec.doco_id || null,
          lifecycleCol,
          rec.body_md ?? null,
          rolePrincipal,
          dataJson,
          rec.created_at ?? new Date().toISOString(),
          rec.created_by ?? null,
          rec.updated_at ?? new Date().toISOString(),
          rec.updated_by ?? null,
        ],
      );
    } else if (rec.entity_type === "user") {
      const dataJson = JSON.stringify(fields);
      const kind = String(fields.kind ?? "person");
      const github_id = (fields.github_id as string | null) ?? null;
      const github_login = (fields.github_login as string | null) ?? null;
      const email = (fields.email as string | null) ?? null;
      const avatar_url = (fields.avatar_url as string | null) ?? null;
      const owner_id = (fields.owner_id as string | null) ?? null;
      const deactivated_at = (fields.deactivated_at as string | null) ?? null;
      await c.query(
        `INSERT INTO users (id, kind, github_id, github_login, email, avatar_url, owner_id, data, deactivated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
         ON CONFLICT (id) DO UPDATE SET kind=EXCLUDED.kind,
           github_id=EXCLUDED.github_id, github_login=EXCLUDED.github_login,
           email=EXCLUDED.email, avatar_url=EXCLUDED.avatar_url,
           owner_id=EXCLUDED.owner_id, data=EXCLUDED.data,
           deactivated_at=EXCLUDED.deactivated_at, updated_at=now()`,
        [
          rec.id,
          kind,
          github_id,
          github_login,
          email,
          avatar_url,
          owner_id,
          dataJson,
          deactivated_at,
        ],
      );
    } else if (rec.entity_type === "organization") {
      const dataJson = JSON.stringify(fields);
      const handle = String(fields.handle ?? rec.id);
      const name = String(fields.name ?? fields.display_name ?? handle);
      await c.query(
        `INSERT INTO organizations (id, handle, name, data) VALUES ($1,$2,$3,$4::jsonb)
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
      const org_id = String(fields.org_id ?? owner_id);
      const handle = String(fields.handle ?? "");
      if (!handle) {
        throw new Error(
          `Cannot upsert doco ${rec.id}: data is missing the required \`handle\` field.`,
        );
      }
      const visibility = String(fields.visibility ?? "private");
      await c.query(
        `INSERT INTO docos (id, handle, owner_id, org_id, visibility, data)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)
         ON CONFLICT (id) DO UPDATE SET handle=EXCLUDED.handle,
           owner_id=EXCLUDED.owner_id, org_id=EXCLUDED.org_id,
           visibility=EXCLUDED.visibility, data=EXCLUDED.data, updated_at=now()`,
        [rec.id, handle, owner_id, org_id, visibility, dataJson],
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
  const spec = tableFor(entityType);
  return withClient(async (c) => {
    const r = await c.query(`SELECT * FROM ${spec.table} WHERE id = $1`, [id]);
    if (r.rowCount === 0) return null;
    return rowToRecord(entityType, r.rows[0]);
  });
}

export async function listEntitiesByDoco(
  entityType: string,
  docoId: string,
): Promise<EntityRecord[]> {
  const spec = tableFor(entityType);
  return withClient(async (c) => {
    const r = await c.query(`SELECT * FROM ${spec.table} WHERE doco_id = $1`, [docoId]);
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
  const spec = tableFor(entityType);
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT * FROM ${spec.table} WHERE doco_id = $1 AND id = ANY($2::text[])`,
      [docoId, ids],
    );
    return r.rows.map((row) => rowToRecord(entityType, row));
  });
}

export async function listIdentityRows(
  entityType: "principal" | "organization" | "doco" | "user",
): Promise<EntityRecord[]> {
  const spec = tableFor(entityType);
  return withClient(async (c) => {
    const r = await c.query(`SELECT * FROM ${spec.table}`);
    return r.rows.map((row) => rowToRecord(entityType, row));
  });
}

/**
 * Columns promoted out of the `data` jsonb by migration 035 that we
 * merge back INTO `data` on read so downstream code that reads
 * `rec.data.verb`, `rec.data.kind`, etc. continues to work without a
 * per-call-site rewrite.
 */
const PROMOTED_COLUMNS_BY_TYPE: Record<string, readonly string[]> = {
  action: ["verb", "performed_at"],
  log: ["verb", "happened_at"],
  eval: ["kind"],
  rule: ["kind", "modality", "severity", "phase", "on_violation"],
  state: ["kind"],
  reference: ["ref_type", "locator", "citation", "title"],
  principal: ["role_principal"],
};

function rowToRecord(entityType: string, row: Record<string, unknown>): EntityRecord {
  // Merge promoted typed columns back into the data jsonb so callers
  // that read structured fields off `rec.data` still find them after
  // migration 035 stripped the keys from the jsonb bag.
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
  // Migration-022: hydrate the type-named column (intent/decision/…)
  // off whichever key the row carries. Empty string is treated as
  // "not set yet" so callers can fall back to summary cleanly during
  // the additive window.
  const tnCol = ALL_ENTITY_TABLES[entityType]?.typeNamedColumn;
  if (tnCol && tnCol in row && row[tnCol] !== null && row[tnCol] !== "") {
    rec.type_named_value = String(row[tnCol]);
  }
  if (row.created_at instanceof Date) rec.created_at = row.created_at.toISOString();
  if ("created_by" in row && row.created_by !== null) rec.created_by = String(row.created_by);
  if (row.updated_at instanceof Date) rec.updated_at = row.updated_at.toISOString();
  if ("updated_by" in row && row.updated_by !== null) rec.updated_by = String(row.updated_by);
  return rec;
}

/** Find a Doco by its `handle` and return its (ULID) id. */
export async function resolveDocoIdByHandle(handle: string): Promise<string | null> {
  return withClient(async (c) => {
    const r = await c.query("SELECT id FROM docos WHERE handle = $1", [handle]);
    if (r.rowCount === 0) return null;
    return String(r.rows[0].id);
  });
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

export async function upsertHostConfig(opts: {
  id: string;
  name: string;
  visibility: "public" | "private";
  data: Record<string, unknown>;
}): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO hosts (id, name, visibility, data)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, visibility=EXCLUDED.visibility,
         data=EXCLUDED.data, updated_at=now()`,
      [opts.id, opts.name, opts.visibility, JSON.stringify(opts.data)],
    );
  });
}

// ─── Users (OAuth identity layer) ─────────────────────────────────

export interface UserRow {
  id: string;
  kind: "person" | "agent";
  github_id: string | null;
  github_login: string | null;
  email: string | null;
  avatar_url: string | null;
  owner_id: string | null;
  data: Record<string, unknown>;
}

function mapUserRow(row: Record<string, unknown>): UserRow {
  const kind = row.kind === "agent" ? "agent" : "person";
  return {
    id: String(row.id),
    kind,
    github_id: row.github_id === null || row.github_id === undefined ? null : String(row.github_id),
    github_login:
      row.github_login === null || row.github_login === undefined ? null : String(row.github_login),
    email: row.email === null || row.email === undefined ? null : String(row.email),
    avatar_url:
      row.avatar_url === null || row.avatar_url === undefined ? null : String(row.avatar_url),
    owner_id: row.owner_id === null || row.owner_id === undefined ? null : String(row.owner_id),
    data: (row.data && typeof row.data === "object" ? row.data : {}) as Record<string, unknown>,
  };
}

export async function getUserById(id: string): Promise<UserRow | null> {
  return withClient(async (c) => {
    const r = await c.query(
      "SELECT id, kind, github_id, github_login, email, avatar_url, owner_id, data FROM users WHERE id = $1",
      [id],
    );
    if (r.rowCount === 0) return null;
    return mapUserRow(r.rows[0]);
  });
}

export async function getUserByGithubLogin(login: string): Promise<UserRow | null> {
  return withClient(async (c) => {
    const r = await c.query(
      "SELECT id, kind, github_id, github_login, email, avatar_url, owner_id, data FROM users WHERE github_login = $1",
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
      RETURNING id, kind, github_id, github_login, email, avatar_url, owner_id, data`,
      [id, JSON.stringify(patch)],
    );
    if (r.rowCount === 0) return null;
    return mapUserRow(r.rows[0]);
  });
}

export async function listUsers(opts: { kind?: "person" | "agent" } = {}): Promise<UserRow[]> {
  return withClient(async (c) => {
    const conds: string[] = [];
    const vals: unknown[] = [];
    if (opts.kind) {
      vals.push(opts.kind);
      conds.push(`kind = $${vals.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const r = await c.query(
      `SELECT id, kind, github_id, github_login, email, avatar_url, owner_id, data
       FROM users ${where} ORDER BY github_login NULLS LAST, id`,
      vals,
    );
    return r.rows.map(mapUserRow);
  });
}

// ─── Principals (role-personas, node) ───────────────────────────────────
//
// Principals are Doco-scoped (migration 020). Each Doco owns its own
// role-personas; the same name in two different Docos is two
// different rows.

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
    const r = await c.query("SELECT id, name, doco_id, data FROM principals WHERE id = $1", [id]);
    if (r.rowCount === 0) return null;
    return mapPrincipalRow(r.rows[0]);
  });
}

export async function getPrincipalByName(
  name: string,
  docoId: string,
): Promise<PrincipalRow | null> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT id, name, doco_id, data
       FROM principals
       WHERE name = $1 AND doco_id = $2
       ORDER BY created_at, id
       LIMIT 1`,
      [name, docoId],
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
       FROM principals
       WHERE doco_id = $1
       ORDER BY name, created_at, id`,
      [docoId],
    );
    return r.rows.map(mapPrincipalRow);
  });
}

// ─── Organizations ────────────────────────────────────────────────────────

export interface OrganizationRow {
  id: string;
  handle: string;
  name: string;
  data: Record<string, unknown>;
  member_count: number;
}

export async function listOrganizations(): Promise<OrganizationRow[]> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT o.id, o.handle, o.name, o.data,
              COALESCE((SELECT count(*) FROM org_users m WHERE m.org_id = o.id), 0) AS member_count
       FROM organizations o ORDER BY o.handle`,
    );
    return r.rows.map((row) => ({
      id: String(row.id),
      handle: String(row.handle),
      name: String(row.name),
      data: (row.data && typeof row.data === "object" ? row.data : {}) as Record<string, unknown>,
      member_count: Number(row.member_count),
    }));
  });
}

export async function listOrganizationsForUser(
  userId: string,
  roles: string[] = ["owner", "writer", "reader"],
): Promise<OrganizationRow[]> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT o.id, o.handle, o.name, o.data,
              COALESCE((SELECT count(*) FROM org_users m WHERE m.org_id = o.id), 0) AS member_count
       FROM organizations o
       JOIN org_users m ON m.org_id = o.id
       WHERE m.user_id = $1 AND m.role = ANY($2)
       ORDER BY o.handle`,
      [userId, roles],
    );
    return r.rows.map((row) => ({
      id: String(row.id),
      handle: String(row.handle),
      name: String(row.name),
      data: (row.data && typeof row.data === "object" ? row.data : {}) as Record<string, unknown>,
      member_count: Number(row.member_count),
    }));
  });
}

export async function isOrgUser(orgId: string, userId: string): Promise<boolean> {
  return withClient(async (c) => {
    const r = await c.query("SELECT 1 FROM org_users WHERE org_id = $1 AND user_id = $2", [
      orgId,
      userId,
    ]);
    return r.rowCount !== null && r.rowCount > 0;
  });
}

/**
 * "Has admin-tier rights on the org." Post-cutover, admin-tier collapses
 * onto the new `owner` role; legacy 'admin'/'member' rows backfill to
 * 'owner' so the behavior is unchanged for existing data.
 */
export async function isOrgAdmin(orgId: string, userId: string): Promise<boolean> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT 1 FROM org_users WHERE org_id = $1 AND user_id = $2 AND role = 'owner'`,
      [orgId, userId],
    );
    return r.rowCount !== null && r.rowCount > 0;
  });
}

export async function upsertOrgUser(opts: {
  org_id: string;
  user_id: string;
  role: DocoRole;
  /** Per-type write set; defaults to wildcard for writer, empty otherwise. */
  write_types?: string[];
}): Promise<void> {
  const writeTypes = normalizeWriteTypes(opts.write_types ?? (opts.role === "writer" ? ["*"] : []));
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO org_users (org_id, user_id, role, write_types)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id, user_id)
       DO UPDATE SET role=EXCLUDED.role, write_types=EXCLUDED.write_types`,
      [opts.org_id, opts.user_id, opts.role, writeTypes],
    );
  });
}

export async function removeOrgUser(orgId: string, userId: string): Promise<void> {
  await withClient(async (c) => {
    await c.query("DELETE FROM org_users WHERE org_id = $1 AND user_id = $2", [orgId, userId]);
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

export async function getOrgRole(orgId: string, userId: string): Promise<DocoRole | null> {
  return withClient(async (c) => {
    const r = await c.query<{ role: string }>(
      "SELECT role FROM org_users WHERE org_id = $1 AND user_id = $2",
      [orgId, userId],
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

export async function getOrgGrant(orgId: string, userId: string): Promise<DocoGrant | null> {
  return withClient(async (c) => {
    const r = await c.query<{ role: string; write_types: string[] }>(
      "SELECT role, write_types FROM org_users WHERE org_id = $1 AND user_id = $2",
      [orgId, userId],
    );
    if (r.rowCount === 0) return null;
    const role = toRole(r.rows[0]?.role);
    if (!role) return null;
    return { role, writeTypes: normalizeWriteTypes(r.rows[0]?.write_types) };
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
    return { role, writeTypes: normalizeWriteTypes(r.rows[0]?.write_types) };
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
    return r.rows.map((row) => ({
      doco_id: String(row.doco_id),
      user_id: String(row.user_id),
      role: (toRole(row.role) ?? "reader") as DocoRole,
      write_types: normalizeWriteTypes(row.write_types),
      joined_at:
        row.joined_at instanceof Date ? row.joined_at.toISOString() : String(row.joined_at),
    }));
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
  const writeTypes = normalizeWriteTypes(opts.write_types ?? (opts.role === "writer" ? ["*"] : []));
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

// ─── Docos ────────────────────────────────────────────────────────────────

export interface DocoRow {
  id: string;
  handle: string;
  /**
   * Owner label — User.github_login for human/agent owners,
   * Organization.handle for org owners. Derived via JOIN in `mapDocoRow`
   * from `owner_id`. NOT a doco identifier.
   */
  owner_slug: string;
  owner_id: string;
  org_id: string;
  visibility: "public" | "private";
  goal: string;
  data: Record<string, unknown>;
}

function mapDocoRow(row: Record<string, unknown>): DocoRow {
  return {
    id: String(row.id),
    handle: String(row.handle ?? ""),
    owner_slug: String(row.owner_slug ?? ""),
    owner_id: String(row.owner_id),
    org_id: String(row.org_id ?? row.owner_id),
    visibility: row.visibility === "public" ? "public" : "private",
    goal: row.goal === null || row.goal === undefined ? "" : String(row.goal),
    data: (row.data && typeof row.data === "object" ? row.data : {}) as Record<string, unknown>,
  };
}

/**
 * Resolves `owner_slug` from `users.github_login` /
 * `organizations.handle` keyed by `docos.owner_id`.
 */
const DOCO_SELECT = `
  SELECT d.id, d.handle, d.owner_id, d.org_id, d.visibility, d.goal, d.data,
         COALESCE(c.github_login, o.handle, '') AS owner_slug
    FROM docos d
    LEFT JOIN users c ON c.id = d.owner_id
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

export async function getDocoByIdOrHandle(idOrHandle: string): Promise<DocoRow | null> {
  if (idOrHandle.startsWith("doco_")) {
    const byId = await getDocoById(idOrHandle);
    if (byId) return byId;
  }
  return getDocoByHandle(idOrHandle);
}

/**
 * Resolve a public owner handle to either a User (by github_login)
 * or an Organization (by handle).
 */
export async function resolveOwnerSlug(
  handle: string,
): Promise<
  { kind: "user"; user: UserRow } | { kind: "organization"; org: OrganizationRow } | null
> {
  const collab = await getUserByGithubLogin(handle);
  if (collab) return { kind: "user", user: collab };
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT id, handle, name, data,
              COALESCE((SELECT count(*) FROM org_users m WHERE m.org_id = organizations.id), 0) AS member_count
       FROM organizations WHERE handle = $1`,
      [handle],
    );
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    return {
      kind: "organization" as const,
      org: {
        id: String(row.id),
        handle: String(row.handle),
        name: String(row.name),
        data: (row.data && typeof row.data === "object" ? row.data : {}) as Record<string, unknown>,
        member_count: Number(row.member_count),
      },
    };
  });
}

// ─── Audit events ─────────────────────────────────────────────────────────

export interface AuditEventRow {
  event_id: string;
  at: string;
  by_user: string | null;
  doco_id: string | null;
  org_id?: string | null;
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
      `INSERT INTO audit_events (event_id, at, by_user, doco_id, org_id, entity_type, entity_id, op, before_json, after_json, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        evt.event_id,
        evt.at,
        evt.by_user,
        evt.doco_id,
        evt.org_id ?? null,
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
  org_id?: string;
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
  if (filters.org_id) {
    where.push(`org_id = $${idx++}`);
    vals.push(filters.org_id);
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
  const sql = `SELECT event_id, at, by_user, doco_id, org_id, entity_type, entity_id, op, before_json, after_json, reason
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
      org_id: row.org_id ? String(row.org_id) : null,
      entity_type: String(row.entity_type),
      entity_id: String(row.entity_id),
      op: String(row.op),
      before_json: row.before_json ?? null,
      after_json: row.after_json ?? null,
      reason: row.reason ?? null,
    }));
  });
}
