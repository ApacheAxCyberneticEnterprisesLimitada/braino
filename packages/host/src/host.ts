import {
  type EntityId,
  HOST_RESERVED_SLUGS,
  type Organization,
  generateUlid,
  makeEntityId,
  nowIso,
  validateRequestedDocoHandle,
} from "@doco/shared";
import { DEFAULT_DOCO_TEMPLATES, type DocoTemplate } from "./doco-templates.js";

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export const RESERVED_HANDLES = HOST_RESERVED_SLUGS;

const BUILTIN_PERSPECTIVE_ATTACHMENTS = [
  { slug: "graph", perspectiveId: "perspective_graph", position: 0 },
  { slug: "list", perspectiveId: "perspective_list", position: 1 },
  { slug: "for-approval", perspectiveId: "perspective_approval", position: 2 },
] as const;

export interface TemplatePerspectiveSeed {
  slug: string;
  perspectiveId?: string;
  position: number;
  isDefault: boolean;
}

export function buildTemplatePerspectiveSeeds(
  template: Pick<DocoTemplate, "perspectives"> | null | undefined,
): TemplatePerspectiveSeed[] {
  const declared = template?.perspectives ?? [];
  const defaultSlug = declared.find((p) => p.isDefault)?.slug ?? "graph";
  const seen = new Set<string>();
  const seeds: TemplatePerspectiveSeed[] = [];

  for (const builtin of BUILTIN_PERSPECTIVE_ATTACHMENTS) {
    seen.add(builtin.slug);
    seeds.push({
      slug: builtin.slug,
      perspectiveId: builtin.perspectiveId,
      position: builtin.position,
      isDefault: defaultSlug === builtin.slug,
    });
  }

  let position = BUILTIN_PERSPECTIVE_ATTACHMENTS.length;
  for (const entry of declared) {
    if (seen.has(entry.slug)) continue;
    seen.add(entry.slug);
    seeds.push({
      slug: entry.slug,
      position,
      isDefault: defaultSlug === entry.slug,
    });
    position += 1;
  }

  return seeds;
}

function assertPublicHandleAllowed(handle: string, kind: "user" | "organization"): void {
  if (!HANDLE_PATTERN.test(handle)) {
    throw new Error(`Invalid ${kind} handle "${handle}" — expected lowercase [a-z0-9][a-z0-9_-]*.`);
  }
  if (HOST_RESERVED_SLUGS.has(handle)) {
    throw new Error(`Handle "${handle}" is reserved by Doco's URL routing.`);
  }
}

export interface AddUserOptions {
  username: string;
  email?: string;
  github_identity?: {
    github_id: string;
    github_login: string;
    email?: string;
  };
}

export async function findUserByGitHubLogin(
  githubLogin: string,
): Promise<{ id: EntityId<"user">; username: string } | null> {
  const { withClient } = await import("@doco/db");
  const r = await withClient((c) =>
    c.query<{ id: string; github_login: string | null }>(
      "SELECT id, github_login FROM users WHERE LOWER(github_login) = LOWER($1) LIMIT 1",
      [githubLogin],
    ),
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id as EntityId<"user">,
    username: row.github_login ?? row.id,
  };
}

export async function addUser(opts: AddUserOptions): Promise<EntityId<"user">> {
  assertPublicHandleAllowed(opts.username, "user");
  const id = makeEntityId("user", generateUlid()) as EntityId<"user">;
  const created = nowIso();
  const gh: { github_id?: string; github_login: string; email?: string } = opts.github_identity ?? {
    github_login: opts.username,
    ...(opts.email ? { email: opts.email } : {}),
  };
  const user = {
    id,
    kind: "person",
    ...(gh.github_id ? { github_id: gh.github_id } : {}),
    github_login: gh.github_login,
    ...(gh.email ? { email: gh.email } : {}),
    ...(opts.email && !gh.email ? { email: opts.email } : {}),
    created_at: created,
  };

  const { withClient } = await import("@doco/db");
  await withClient(async (c) => {
    const dup = await c.query(
      `SELECT 1 FROM users WHERE LOWER(github_login) = LOWER($1)
       UNION
       SELECT 1 FROM organizations WHERE handle = $1
       LIMIT 1`,
      [opts.username],
    );
    if (dup.rows.length > 0) {
      throw new Error(`Handle "${opts.username}" is already taken.`);
    }
    await c.query(
      `INSERT INTO users
        (id, kind, github_id, github_login, email, data, created_at, updated_at)
       VALUES ($1, 'person', $2, $3, $4, $5::jsonb, $6, $6)`,
      [
        id,
        gh.github_id ?? null,
        gh.github_login ?? opts.username,
        opts.email ?? gh.email ?? null,
        JSON.stringify(user),
        created,
      ],
    );
  });
  await ensurePersonalOrganization(id, opts.username);
  return id;
}

export async function ensurePersonalOrganization(
  userId: string,
  username: string,
): Promise<EntityId<"organization">> {
  const { withClient } = await import("@doco/db");
  return withClient(async (c) => {
    const existing = await c.query<{ id: string }>(
      "SELECT id FROM organizations WHERE handle = $1 LIMIT 1",
      [username],
    );
    if (existing.rows[0]) {
      await c.query(
        `INSERT INTO org_users (org_id, user_id, role)
         VALUES ($1, $2, 'owner')
         ON CONFLICT (org_id, user_id) DO NOTHING`,
        [existing.rows[0].id, userId],
      );
      return existing.rows[0].id as EntityId<"organization">;
    }

    const id = makeEntityId("organization", generateUlid()) as EntityId<"organization">;
    const created = nowIso();
    const data = {
      id,
      handle: username,
      owner_id: userId,
      created_at: created,
    };
    await c.query(
      `INSERT INTO organizations (id, handle, name, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $5)`,
      [id, username, username, JSON.stringify(data), created],
    );
    await c.query(
      `INSERT INTO org_users (org_id, user_id, role, joined_at)
       VALUES ($1, $2, 'owner', $3)`,
      [id, userId, created],
    );
    return id;
  });
}

export async function findAvailableOrgHandle(requested: string): Promise<string> {
  const base = requested.trim().toLowerCase();
  if (!base) throw new Error("Organization handle is required.");
  assertPublicHandleAllowed(base, "organization");
  const { withClient } = await import("@doco/db");
  return withClient(async (c) => {
    let candidate = base;
    let n = 2;
    while (true) {
      const taken = await c.query("SELECT 1 FROM organizations WHERE handle = $1 LIMIT 1", [
        candidate,
      ]);
      if (taken.rows.length === 0) return candidate;
      candidate = `${base}-${n}`;
      n += 1;
      if (n > 1000) throw new Error("Could not find an available handle.");
    }
  });
}

export async function findAvailableDocoHandle(requestedHandle: string): Promise<string> {
  const base = requestedHandle.trim().toLowerCase();
  const handleError = validateRequestedDocoHandle(base);
  if (handleError) throw new Error(handleError);
  const { withClient } = await import("@doco/db");
  return withClient(async (c) => {
    let candidate = base;
    let n = 2;
    while (true) {
      const taken = await c.query("SELECT 1 FROM docos WHERE handle = $1 LIMIT 1", [candidate]);
      if (taken.rowCount === 0) return candidate;
      candidate = `${base}-${n}`;
      n += 1;
      if (n > 1000) throw new Error("Could not find an available handle.");
    }
  });
}

export async function addOrganizationByHandle(opts: {
  handle: string;
  ownerUserId: string;
  autoSuffix?: boolean;
}): Promise<{ id: EntityId<"organization">; handle: string }> {
  assertPublicHandleAllowed(opts.handle, "organization");
  const { withClient } = await import("@doco/db");
  const finalHandle = opts.autoSuffix ? await findAvailableOrgHandle(opts.handle) : opts.handle;
  return withClient(async (c) => {
    if (!opts.autoSuffix) {
      const taken = await c.query("SELECT 1 FROM organizations WHERE handle = $1 LIMIT 1", [
        finalHandle,
      ]);
      if (taken.rows.length > 0) {
        throw new Error(`Handle "${finalHandle}" is already taken.`);
      }
    }
    const id = makeEntityId("organization", generateUlid()) as EntityId<"organization">;
    const created = nowIso();
    const data = {
      id,
      handle: finalHandle,
      owner_id: opts.ownerUserId,
      created_at: created,
    };
    await c.query(
      `INSERT INTO organizations (id, handle, name, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $5)`,
      [id, finalHandle, finalHandle, JSON.stringify(data), created],
    );
    await c.query(
      `INSERT INTO org_users (org_id, user_id, role, joined_at)
       VALUES ($1, $2, 'owner', $3)`,
      [id, opts.ownerUserId, created],
    );
    return { id, handle: finalHandle };
  });
}

export async function createDocoInOrg(opts: {
  orgId: string;
  requestedHandle: string;
  createdByUserId: string;
  visibility?: "private" | "public";
  templateHandle?: string | null;
  autoSuffix?: boolean;
  /**
   * Project-owner-authored sentence describing what this Doco is for.
   * When omitted, defaults to the chosen template's `description`
   * (templated Docos) or an empty string (no-template Docos). Pass
   * an explicit string — including the empty string — to override the
   * template default.
   */
  goal?: string;
}): Promise<{
  docoId: EntityId<"doco">;
  orgId: string;
  orgHandle: string;
  handle: string;
  goal: string;
}> {
  const baseHandle = opts.requestedHandle.trim().toLowerCase();
  const handleError = validateRequestedDocoHandle(baseHandle);
  if (handleError) throw new Error(handleError);

  const { withClient } = await import("@doco/db");
  return withClient(async (c) => {
    const orgRow = await c.query<{ id: string; handle: string }>(
      "SELECT id, handle FROM organizations WHERE id = $1",
      [opts.orgId],
    );
    if (orgRow.rowCount === 0) {
      throw new Error(`Organization "${opts.orgId}" not found.`);
    }
    const orgHandle = String(orgRow.rows[0]?.handle ?? "");
    if (!orgHandle) {
      throw new Error(`Organization "${opts.orgId}" has no handle.`);
    }

    let handle = baseHandle;
    const taken = await c.query("SELECT 1 FROM docos WHERE handle = $1 LIMIT 1", [handle]);
    if ((taken.rowCount ?? 0) > 0) {
      if (!opts.autoSuffix) {
        throw new Error(`Doco handle "${baseHandle}" is already taken.`);
      }
      let n = 2;
      while (true) {
        handle = `${baseHandle}-${n}`;
        const dup = await c.query("SELECT 1 FROM docos WHERE handle = $1 LIMIT 1", [handle]);
        if ((dup.rowCount ?? 0) === 0) break;
        n += 1;
        if (n > 999) throw new Error(`Auto-suffix exhausted for "${baseHandle}".`);
      }
    }

    const docoId = makeEntityId("doco", generateUlid()) as EntityId<"doco">;
    const created = nowIso();
    const visibility = opts.visibility ?? "private";
    const template = opts.templateHandle ? findDocoTemplate(opts.templateHandle) : null;
    const allowedNeuronTypes = template?.allowedNeuronTypes ?? null;
    const defaultNeuronLifecycle = template?.defaultNeuronLifecycle ?? null;
    // Goal: explicit caller value wins (including ""), else the
    // template's description, else empty for no-template Docos.
    const goal = opts.goal !== undefined ? opts.goal : (template?.description ?? "");
    const data: Record<string, unknown> = {
      id: docoId,
      handle,
      visibility,
      owner_id: opts.orgId,
      org_id: opts.orgId,
      template_handle: opts.templateHandle ?? null,
      created_at: created,
      created_by: opts.createdByUserId,
      lifecycle: "asserted",
      ...(allowedNeuronTypes ? { allowed_neuron_types: allowedNeuronTypes } : {}),
      ...(defaultNeuronLifecycle ? { default_neuron_lifecycle: defaultNeuronLifecycle } : {}),
    };

    await c.query(
      `INSERT INTO docos (id, handle, owner_id, org_id, visibility, data,
                          allowed_neuron_types, default_neuron_lifecycle,
                          goal,
                          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $10)`,
      [
        docoId,
        handle,
        opts.orgId,
        opts.orgId,
        visibility,
        JSON.stringify(data),
        allowedNeuronTypes,
        defaultNeuronLifecycle,
        goal,
        created,
      ],
    );
    // Skip the doco_users insert when the creator is already `owner`
    // on the owning org — they'd inherit owner role via getDocoLevelRole
    // and the explicit row would just be redundant. We only carry the
    // doco_users grant for creators whose org role is below owner; in
    // that case they need an explicit owner row on what they created.
    const orgRoleRow = await c.query<{ role: string }>(
      "SELECT role FROM org_users WHERE org_id = $1 AND user_id = $2",
      [opts.orgId, opts.createdByUserId],
    );
    const orgRole = orgRoleRow.rows[0]?.role;
    if (orgRole !== "owner") {
      await c.query(
        `INSERT INTO doco_users (doco_id, user_id, role, joined_at)
         VALUES ($1, $2, 'owner', $3)
         ON CONFLICT (doco_id, user_id) DO UPDATE SET role = 'owner'`,
        [docoId, opts.createdByUserId, created],
      );
    }

    if (template && template.policies.length > 0) {
      for (const policy of template.policies) {
        const isAuthoring = Boolean(policy.predicate);
        const firesWhen = Array.isArray(policy.fires_when_neuron_lifecycle)
          ? policy.fires_when_neuron_lifecycle
          : [];
        const entityType = isAuthoring ? "neuron_authoring_policy" : "guidance_policy";
        const table = isAuthoring ? "neuron_authoring_policies" : "guidance_policies";
        const policyId = `${entityType}_${generateUlid()}`;
        const policyData: Record<string, unknown> = {
          id: policyId,
          doco_id: docoId,
          policy_kind: isAuthoring ? "neuron_authoring" : "guidance",
          policy: policy.policy,
          ...(policy.predicate
            ? {
                evaluation_kind:
                  policy.predicate.kind === "probabilistic" ? "probabilistic" : "deterministic",
                predicate: policy.predicate,
                on_violation: policy.on_violation ?? "block",
              }
            : {}),
          ...(firesWhen.length > 0 ? { fires_when_neuron_lifecycle: firesWhen } : {}),
          template_seeded: true,
          template_handle: opts.templateHandle ?? null,
          created_at: created,
          created_by: opts.createdByUserId,
          lifecycle: "asserted",
        };
        await c.query(
          // policies table column renamed from `summary` to `policy`
          // in migration 038; the seed insert tracks the new name.
          `INSERT INTO ${table} (id, doco_id, policy, data, body_md, lifecycle,
                                created_at, updated_at, created_by, updated_by)
           VALUES ($1, $2, $3, $4::jsonb, $5, 'asserted', $6, $6, $7, $7)`,
          [
            policyId,
            docoId,
            policy.policy,
            JSON.stringify(policyData),
            policy.body_md ?? "",
            created,
            opts.createdByUserId,
          ],
        );
      }
    }

    let insertedDefaultPerspective = false;
    for (const entry of buildTemplatePerspectiveSeeds(template)) {
      const perspectiveId =
        entry.perspectiveId ??
        (await c.query<{ id: string }>("SELECT id FROM perspectives WHERE slug = $1", [entry.slug]))
          .rows[0]?.id;
      if (!perspectiveId) continue;
      if (entry.isDefault) insertedDefaultPerspective = true;
      await c.query(
        `INSERT INTO doco_perspectives (doco_id, perspective_id, position, is_default, attached_at, attached_by_user)
              VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (doco_id, perspective_id) DO NOTHING`,
        [docoId, perspectiveId, entry.position, entry.isDefault, created, opts.createdByUserId],
      );
    }
    if (!insertedDefaultPerspective) {
      await c.query(
        `UPDATE doco_perspectives
            SET is_default = true
          WHERE doco_id = $1 AND perspective_id = 'perspective_graph'`,
        [docoId],
      );
    }

    return { docoId, orgId: opts.orgId, orgHandle, handle, goal };
  });
}

export function findDocoTemplate(handle: string): DocoTemplate | null {
  return DEFAULT_DOCO_TEMPLATES.find((tpl) => tpl.name === handle) ?? null;
}

export interface UpdateDocoOptions {
  handle: string;
  visibility?: "private" | "public";
  /**
   * New goal. Empty string clears it. `undefined` leaves the current
   * value untouched.
   */
  goal?: string;
}

export async function updateDocoMeta(opts: UpdateDocoOptions): Promise<void> {
  if (
    opts.visibility !== undefined &&
    opts.visibility !== "private" &&
    opts.visibility !== "public"
  ) {
    throw new Error(`visibility must be "private" or "public", got: ${opts.visibility}`);
  }
  const { withClient } = await import("@doco/db");
  await withClient(async (c) => {
    const cur = await c.query("SELECT 1 FROM docos WHERE handle = $1 LIMIT 1", [opts.handle]);
    if ((cur.rowCount ?? 0) === 0) throw new Error(`Doco "${opts.handle}" not found.`);
    await c.query(
      `UPDATE docos
          SET visibility = COALESCE($2, visibility),
              goal       = COALESCE($3, goal),
              data       = CASE
                             WHEN $2::text IS NULL THEN data - 'display_name' - 'name'
                             ELSE jsonb_set(data - 'display_name' - 'name', '{visibility}', to_jsonb($2::text), true)
                           END,
              updated_at = now()
        WHERE handle = $1`,
      [opts.handle, opts.visibility ?? null, opts.goal ?? null],
    );
  });
}

export async function renameDocoHandle(opts: {
  oldHandle: string;
  newHandle: string;
}): Promise<void> {
  const { oldHandle, newHandle } = opts;
  const handleError = validateRequestedDocoHandle(newHandle);
  if (handleError) throw new Error(handleError);
  if (oldHandle === newHandle) return;

  const { withClient } = await import("@doco/db");
  await withClient(async (c) => {
    const cur = await c.query<{ data: Record<string, unknown> | null }>(
      "SELECT data FROM docos WHERE handle = $1 LIMIT 1",
      [oldHandle],
    );
    if (!cur.rows[0]) throw new Error(`Doco "${oldHandle}" not found.`);
    const dup = await c.query("SELECT 1 FROM docos WHERE handle = $1 LIMIT 1", [newHandle]);
    if (dup.rows[0]) throw new Error(`Doco "${newHandle}" already exists.`);
    const data: Record<string, unknown> = Object.fromEntries(
      Object.entries(cur.rows[0].data ?? {}).filter(
        ([key]) => key !== "display_name" && key !== "name",
      ),
    );
    data.handle = newHandle;
    await c.query(
      `UPDATE docos
          SET handle     = $2,
              data       = $3::jsonb,
              updated_at = now()
        WHERE handle = $1`,
      [oldHandle, newHandle, JSON.stringify(data)],
    );
  });
}

export async function softDeleteDoco(opts: {
  handle?: string;
  docoId?: string;
}): Promise<{ deletedPath: string }> {
  const { withClient } = await import("@doco/db");

  let label: string;
  let result: { rowCount: number | null; rows: Array<{ id: string; handle: string }> };
  if (opts.docoId) {
    label = opts.docoId;
    result = await withClient((c) =>
      c.query<{ id: string; handle: string }>(
        "DELETE FROM docos WHERE id = $1 RETURNING id, handle",
        [opts.docoId],
      ),
    );
  } else {
    const handle = opts.handle;
    if (!handle) throw new Error("Doco id or handle is required.");
    label = handle;
    result = await withClient((c) =>
      c.query<{ id: string; handle: string }>(
        "DELETE FROM docos WHERE handle = $1 RETURNING id, handle",
        [handle],
      ),
    );
  }

  if (result.rowCount === 0) {
    throw new Error(`Doco "${label}" not found.`);
  }
  const deleted = result.rows[0];
  return { deletedPath: `postgres:docos/${deleted.handle}` };
}

export type { Organization };
