import {
  DEFAULT_WORKSPACE_CONSTITUTION,
  type EntityId,
  HOST_RESERVED_SLUGS,
  generateUlid,
  makeEntityId,
  nowIso,
  validateRequestedCollectionHandle,
} from "@doco/shared";
import {
  type CollectionTemplate,
  DEFAULT_COLLECTION_TEMPLATES,
  templatePolicyToPolicyRow,
} from "./collection-templates.js";

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

const BUILTIN_PERSPECTIVE_ATTACHMENTS = [
  { slug: "graph", perspectiveId: "perspective_graph", position: 0 },
  { slug: "list", perspectiveId: "perspective_list", position: 1 },
] as const;

export interface TemplatePerspectiveSeed {
  slug: string;
  perspectiveId?: string;
  position: number;
  isDefault: boolean;
}

export function buildTemplatePerspectiveSeeds(
  template: Pick<CollectionTemplate, "perspectives"> | null | undefined,
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

function assertWorkspaceHandleAllowed(handle: string): void {
  if (!HANDLE_PATTERN.test(handle)) {
    throw new Error(
      `Invalid workspace handle "${handle}" — expected lowercase [a-z0-9][a-z0-9_-]*.`,
    );
  }
  // The handle is the workspace's subdomain, and a DNS label holds 63 characters.
  if (handle.length > 63) {
    throw new Error(`Workspace handle "${handle}" is too long (max 63 chars).`);
  }
  if (HOST_RESERVED_SLUGS.has(handle)) {
    throw new Error(`Handle "${handle}" is reserved by collection's URL routing.`);
  }
}

export async function findAvailableWorkspaceHandle(requested: string): Promise<string> {
  const base = requested.trim().toLowerCase();
  if (!base) throw new Error("Workspace handle is required.");
  assertWorkspaceHandleAllowed(base);
  const { withClient } = await import("@doco/db");
  return withClient(async (c) => {
    let candidate = base;
    let n = 2;
    while (true) {
      const taken = await c.query("SELECT 1 FROM workspaces WHERE handle = $1 LIMIT 1", [
        candidate,
      ]);
      if (taken.rows.length === 0) return candidate;
      candidate = `${base}-${n}`;
      n += 1;
      if (n > 1000) throw new Error("Could not find an available handle.");
    }
  });
}

export async function findAvailableCollectionHandle(requestedHandle: string): Promise<string> {
  const base = requestedHandle.trim().toLowerCase();
  const handleError = validateRequestedCollectionHandle(base);
  if (handleError) throw new Error(handleError);
  const { withClient } = await import("@doco/db");
  return withClient(async (c) => {
    let candidate = base;
    let n = 2;
    while (true) {
      const taken = await c.query("SELECT 1 FROM collections WHERE handle = $1 LIMIT 1", [
        candidate,
      ]);
      if (taken.rowCount === 0) return candidate;
      candidate = `${base}-${n}`;
      n += 1;
      if (n > 1000) throw new Error("Could not find an available handle.");
    }
  });
}

/**
 * The collections every new workspace starts with, in the order they are
 * created. Each entry is a template name from `DEFAULT_COLLECTION_TEMPLATES`;
 * the seeded collection's handle is `<workspace-handle>-<template name>`.
 */
export const DEFAULT_WORKSPACE_COLLECTION_TEMPLATES = [
  "glossary",
  "ideas",
  "product-roadmap",
  "product-decisions",
  "design-decisions",
  "architectural-decisions",
  "process",
  "bugs",
  "agents-chats",
] as const;

/**
 * Create a workspace owned by `ownerUserId` and seed it with the
 * `DEFAULT_WORKSPACE_COLLECTION_TEMPLATES` Collections.
 */
export async function addWorkspaceByHandle(opts: {
  handle: string;
  ownerUserId: string;
  autoSuffix?: boolean;
}): Promise<{ id: EntityId<"workspace">; handle: string }> {
  const workspace = await insertWorkspace(opts);
  for (const templateHandle of DEFAULT_WORKSPACE_COLLECTION_TEMPLATES) {
    await createCollectionInWorkspace({
      workspaceId: workspace.id,
      requestedHandle: `${workspace.handle}-${templateHandle}`,
      createdByUserId: opts.ownerUserId,
      templateHandle,
      autoSuffix: true,
    });
  }
  return workspace;
}

async function insertWorkspace(opts: {
  handle: string;
  ownerUserId: string;
  autoSuffix?: boolean;
}): Promise<{ id: EntityId<"workspace">; handle: string }> {
  assertWorkspaceHandleAllowed(opts.handle);
  const { withClient } = await import("@doco/db");
  const finalHandle = opts.autoSuffix
    ? await findAvailableWorkspaceHandle(opts.handle)
    : opts.handle;
  return withClient(async (c) => {
    if (!opts.autoSuffix) {
      const taken = await c.query("SELECT 1 FROM workspaces WHERE handle = $1 LIMIT 1", [
        finalHandle,
      ]);
      if (taken.rows.length > 0) {
        throw new Error(`Handle "${finalHandle}" is already taken.`);
      }
    }
    const id = makeEntityId("workspace", generateUlid()) as EntityId<"workspace">;
    const created = nowIso();
    await c.query(
      `INSERT INTO workspaces (id, handle, name, constitution, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [id, finalHandle, finalHandle, DEFAULT_WORKSPACE_CONSTITUTION, created],
    );
    await c.query(
      `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at)
       VALUES ($1, $2, 'owner', $3)`,
      [id, opts.ownerUserId, created],
    );
    return { id, handle: finalHandle };
  });
}

export async function createCollectionInWorkspace(opts: {
  workspaceId: string;
  requestedHandle: string;
  createdByUserId: string;
  visibility?: "private" | "public";
  templateHandle?: string | null;
  autoSuffix?: boolean;
  /**
   * Project-owner-authored sentence describing what this collection is for.
   * When omitted, defaults to the chosen template's `description`
   * (templated collections) or an empty string (no-template collections). Pass
   * an explicit string — including the empty string — to override the
   * template default.
   */
  goal?: string;
}): Promise<{
  collectionId: EntityId<"collection">;
  workspaceId: string;
  workspaceHandle: string;
  handle: string;
  goal: string;
}> {
  const baseHandle = opts.requestedHandle.trim().toLowerCase();
  const handleError = validateRequestedCollectionHandle(baseHandle);
  if (handleError) throw new Error(handleError);

  const { withClient } = await import("@doco/db");
  return withClient(async (c) => {
    const workspaceRow = await c.query<{ id: string; handle: string }>(
      "SELECT id, handle FROM workspaces WHERE id = $1",
      [opts.workspaceId],
    );
    if (workspaceRow.rowCount === 0) {
      throw new Error(`Workspace "${opts.workspaceId}" not found.`);
    }
    const workspaceHandle = String(workspaceRow.rows[0]?.handle ?? "");
    if (!workspaceHandle) {
      throw new Error(`Workspace "${opts.workspaceId}" has no handle.`);
    }

    let handle = baseHandle;
    const taken = await c.query("SELECT 1 FROM collections WHERE handle = $1 LIMIT 1", [handle]);
    if ((taken.rowCount ?? 0) > 0) {
      if (!opts.autoSuffix) {
        throw new Error(`Collection handle "${baseHandle}" is already taken.`);
      }
      let n = 2;
      while (true) {
        handle = `${baseHandle}-${n}`;
        const dup = await c.query("SELECT 1 FROM collections WHERE handle = $1 LIMIT 1", [handle]);
        if ((dup.rowCount ?? 0) === 0) break;
        n += 1;
        if (n > 999) throw new Error(`Auto-suffix exhausted for "${baseHandle}".`);
      }
    }

    const collectionId = makeEntityId("collection", generateUlid()) as EntityId<"collection">;
    const created = nowIso();
    const visibility = opts.visibility ?? "private";
    const template = opts.templateHandle ? findCollectionTemplate(opts.templateHandle) : null;
    const defaultNodeLifecycle = template?.defaultNodeLifecycle ?? null;
    // Goal: explicit caller value wins (including ""), else the
    // template's description, else empty for no-template collections.
    const goal = opts.goal !== undefined ? opts.goal : (template?.description ?? "");
    const data: Record<string, unknown> = {
      id: collectionId,
      handle,
      visibility,
      owner_id: opts.workspaceId,
      workspace_id: opts.workspaceId,
      template_handle: opts.templateHandle ?? null,
      created_at: created,
      created_by: opts.createdByUserId,
      lifecycle: "active",
      ...(defaultNodeLifecycle ? { default_node_lifecycle: defaultNodeLifecycle } : {}),
    };

    await c.query(
      `INSERT INTO collections (id, handle, owner_id, workspace_id, visibility, data,
                          default_node_lifecycle,
                          goal,
                          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $9)`,
      [
        collectionId,
        handle,
        opts.workspaceId,
        opts.workspaceId,
        visibility,
        JSON.stringify(data),
        defaultNodeLifecycle,
        goal,
        created,
      ],
    );
    // Skip the collection_users insert when the creator is already `owner`
    // on the owning workspace — they'd inherit owner role via getCollectionLevelRole
    // and the explicit row would just be redundant. We only carry the
    // collection_users grant for creators whose workspace role is below owner; in
    // that case they need an explicit owner row on what they created.
    const workspaceRoleRow = await c.query<{ role: string }>(
      "SELECT role FROM workspace_users WHERE workspace_id = $1 AND user_id = $2",
      [opts.workspaceId, opts.createdByUserId],
    );
    const workspaceRole = workspaceRoleRow.rows[0]?.role;
    if (workspaceRole !== "owner") {
      await c.query(
        `INSERT INTO collection_users (collection_id, user_id, role, joined_at)
         VALUES ($1, $2, 'owner', $3)
         ON CONFLICT (collection_id, user_id) DO UPDATE SET role = 'owner'`,
        [collectionId, opts.createdByUserId, created],
      );
    }

    if (template && template.policies.length > 0) {
      for (const policy of template.policies) {
        // Translate the (still old-shape) TemplatePolicy into the unified
        // policy row (a standalone `kind` plus an evaluator predicate). The
        // pure translation lives in `templatePolicyToPolicyRow` so the
        // template scenario tests seed the exact same rows we enforce here.
        const row = templatePolicyToPolicyRow(policy);
        const policyId = `policy_${generateUlid()}`;
        const policyData: Record<string, unknown> = {
          id: policyId,
          collection_id: collectionId,
          kind: row.kind,
          predicate: row.predicate,
          ...(row.on_violation !== undefined ? { on_violation: row.on_violation } : {}),
          ...(row.fires_when_node_lifecycle
            ? { fires_when_node_lifecycle: row.fires_when_node_lifecycle }
            : {}),
          template_seeded: true,
          template_handle: opts.templateHandle ?? null,
          created_at: created,
          created_by: opts.createdByUserId,
          lifecycle: "active",
        };
        await c.query(
          `INSERT INTO policies (id, collection_id, kind, data, lifecycle,
                                created_at, updated_at, created_by, updated_by)
           VALUES ($1, $2, $3, $4::jsonb, 'active', $5, $5, $6, $6)`,
          [
            policyId,
            collectionId,
            row.kind,
            JSON.stringify(policyData),
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
        `INSERT INTO collection_perspectives (collection_id, perspective_id, position, is_default, attached_at, attached_by_user)
              VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (collection_id, perspective_id) DO NOTHING`,
        [
          collectionId,
          perspectiveId,
          entry.position,
          entry.isDefault,
          created,
          opts.createdByUserId,
        ],
      );
    }
    if (!insertedDefaultPerspective) {
      await c.query(
        `UPDATE collection_perspectives
            SET is_default = true
          WHERE collection_id = $1 AND perspective_id = 'perspective_graph'`,
        [collectionId],
      );
    }

    return { collectionId, workspaceId: opts.workspaceId, workspaceHandle, handle, goal };
  });
}

export function findCollectionTemplate(handle: string): CollectionTemplate | null {
  return DEFAULT_COLLECTION_TEMPLATES.find((tpl) => tpl.name === handle) ?? null;
}

export interface UpdateCollectionOptions {
  handle: string;
  visibility?: "private" | "public";
  /**
   * New goal. Empty string clears it. `undefined` leaves the current
   * value untouched.
   */
  goal?: string;
}

export async function updateCollectionMeta(opts: UpdateCollectionOptions): Promise<void> {
  if (
    opts.visibility !== undefined &&
    opts.visibility !== "private" &&
    opts.visibility !== "public"
  ) {
    throw new Error(`visibility must be "private" or "public", got: ${opts.visibility}`);
  }
  const { withClient } = await import("@doco/db");
  await withClient(async (c) => {
    const cur = await c.query("SELECT 1 FROM collections WHERE handle = $1 LIMIT 1", [opts.handle]);
    if ((cur.rowCount ?? 0) === 0) throw new Error(`Collection "${opts.handle}" not found.`);
    await c.query(
      `UPDATE collections
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

export async function renameCollectionHandle(opts: {
  oldHandle: string;
  newHandle: string;
}): Promise<void> {
  const { oldHandle, newHandle } = opts;
  const handleError = validateRequestedCollectionHandle(newHandle);
  if (handleError) throw new Error(handleError);
  if (oldHandle === newHandle) return;

  const { withClient } = await import("@doco/db");
  await withClient(async (c) => {
    const cur = await c.query<{ data: Record<string, unknown> | null }>(
      "SELECT data FROM collections WHERE handle = $1 LIMIT 1",
      [oldHandle],
    );
    if (!cur.rows[0]) throw new Error(`Collection "${oldHandle}" not found.`);
    const dup = await c.query("SELECT 1 FROM collections WHERE handle = $1 LIMIT 1", [newHandle]);
    if (dup.rows[0]) throw new Error(`Collection "${newHandle}" already exists.`);
    const data: Record<string, unknown> = Object.fromEntries(
      Object.entries(cur.rows[0].data ?? {}).filter(
        ([key]) => key !== "display_name" && key !== "name",
      ),
    );
    data.handle = newHandle;
    await c.query(
      `UPDATE collections
          SET handle     = $2,
              data       = $3::jsonb,
              updated_at = now()
        WHERE handle = $1`,
      [oldHandle, newHandle, JSON.stringify(data)],
    );
  });
}

/**
 * Soft-delete a collection. Stamps `deleted_at` so the collection vanishes from every
 * read path immediately, while its rows are retained for a 30-day grace
 * window; the `admin.purge-deleted-collections` cron hard-deletes it (cascading
 * everything) once the window lapses. Throws if the collection is absent or already
 * tombstoned, matching the old "not found" contract.
 */
export async function softDeleteCollection(opts: {
  handle?: string;
  collectionId?: string;
}): Promise<{ deletedPath: string }> {
  if (!opts.collectionId && !opts.handle) throw new Error("Collection id or handle is required.");
  const { markCollectionDeleted } = await import("@doco/db");
  const deleted = await markCollectionDeleted(opts);
  if (!deleted) {
    throw new Error(`Collection "${opts.collectionId ?? opts.handle}" not found.`);
  }
  return { deletedPath: `postgres:collections/${deleted.handle}` };
}
