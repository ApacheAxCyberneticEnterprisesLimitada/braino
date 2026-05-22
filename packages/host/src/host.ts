import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type EntityId,
  HOST_RESERVED_SLUGS,
  type Organization,
  generateUlid,
  makeEntityId,
  nowIso,
  validateRequestedDocoId as validateRequestedDocoHandle,
} from "@doco/shared";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { DEFAULT_DOCO_TEMPLATES, type DocoTemplate } from "./doco-templates.js";
import {
  detectMode,
  hostDocoDir,
  hostDocosDir,
  hostOrganizationsDir,
  hostPrincipalsDir,
  hostYamlPath,
} from "./mode.js";

export interface HostConfig {
  id: string; // host_<ulid> — meta-Doco style
  schema_version: string;
  name: string;
  created_at: string;
  created_by: EntityId<"collaborator"> | null;
  visibility: "private" | "public";
}

export interface CreateHostOptions {
  name: string;
  ownerUsername?: string; // create the bootstrap Principal too
  ownerEmail?: string;
  visibility?: "private" | "public";
}

export async function createHost(
  root: string,
  opts: CreateHostOptions,
): Promise<{ host: HostConfig; bootstrapPrincipalId: EntityId<"collaborator"> | null }> {
  if (detectMode(root) !== "empty") {
    throw new Error(`Refusing to overwrite: ${root} is already a Host or Doco.`);
  }
  if (opts.ownerUsername) {
    assertSlugAllowed(opts.ownerUsername, "principal");
  }
  await mkdir(root, { recursive: true });
  await mkdir(hostPrincipalsDir(root), { recursive: true });
  await mkdir(hostOrganizationsDir(root), { recursive: true });
  await mkdir(hostDocosDir(root), { recursive: true });

  // Optional bootstrap Collaborator (was "Principal" pre-rename; the
  // OAuth identity layer is now `collaborators`).
  let bootstrapId: EntityId<"collaborator"> | null = null;
  if (opts.ownerUsername) {
    const created = nowIso();
    const id = makeEntityId("collaborator", generateUlid()) as EntityId<"collaborator">;
    const collaborator = {
      id,
      kind: "person",
      github_login: opts.ownerUsername,
      ...(opts.ownerEmail ? { email: opts.ownerEmail } : {}),
      created_at: created,
    };
    const { withClient } = await import("@doco/db");
    await withClient(async (c) => {
      const dup = await c.query(
        `SELECT 1 FROM collaborators WHERE github_login = $1
         UNION
         SELECT 1 FROM principals WHERE username = $1
         UNION
         SELECT 1 FROM organizations WHERE slug = $1
         LIMIT 1`,
        [opts.ownerUsername],
      );
      if (dup.rows.length > 0) {
        throw new Error(`Slug "${opts.ownerUsername}" is already taken.`);
      }
      await c.query(
        `INSERT INTO collaborators
          (id, kind, github_login, email, data, created_at, updated_at)
         VALUES ($1, 'person', $2, $3, $4::jsonb, $5, $5)`,
        [
          id,
          opts.ownerUsername,
          opts.ownerEmail ?? null,
          JSON.stringify(collaborator),
          created,
        ],
      );
    });
    await writeFile(
      join(hostPrincipalsDir(root), `${id}.yaml`),
      stringifyYaml(collaborator),
      "utf8",
    );
    bootstrapId = id;
  }

  // host.yaml
  const host: HostConfig = {
    id: `host_${generateUlid()}`,
    schema_version: "0.1",
    name: opts.name,
    created_at: nowIso(),
    created_by: bootstrapId,
    visibility: opts.visibility ?? "private",
  };
  await writeFile(hostYamlPath(root), stringifyYaml(host), "utf8");

  // .gitignore + README
  await writeFile(
    join(root, ".gitignore"),
    "# Host-level token store\n.doco-host/\n# OS\n.DS_Store\n",
    "utf8",
  );
  await writeFile(
    join(root, "README.md"),
    `# ${opts.name}

A multi-tenant Doco Host. See [ADR-061](https://example.invalid).

Host administration (creating users, organizations, and Docos) is done
through the Doco web admin UI at the host root URL. There is no host
admin CLI — \`doco-cli\` only carries \`login\` and \`install-agent-bootstrap\`
for connecting individual repos to their Doco.
`,
    "utf8",
  );

  return { host, bootstrapPrincipalId: bootstrapId };
}

export async function loadHost(root: string): Promise<HostConfig> {
  const text = await readFile(hostYamlPath(root), "utf8");
  return parseYaml(text) as HostConfig;
}

// ──────────────────────────────────────────────────────────────────────────
// Owner namespace (ADR-064): Principal.username and Organization.slug share one
// flat namespace within a host.
// ──────────────────────────────────────────────────────────────────────────

export type OwnerSummary =
  | { kind: "principal"; id: EntityId<"principal">; slug: string; label: string }
  | { kind: "organization"; id: EntityId<"organization">; slug: string; display_name: string };

export async function listPrincipals(_root: string): Promise<OwnerSummary[]> {
  // Post-rename: list users-of-the-host = list collaborators (the OAuth
  // identity layer). The function name is kept for caller compatibility;
  // role-personas (the neuron type "principal") aren't host-level users.
  const { withClient } = await import("@doco/db");
  const r = await withClient((c) =>
    c.query<{ id: string; github_login: string | null }>(
      "SELECT id, github_login FROM collaborators WHERE deactivated_at IS NULL ORDER BY github_login NULLS LAST",
    ),
  );
  return r.rows.map((row) => ({
    kind: "principal" as const,
    id: row.id as EntityId<"principal">,
    slug: row.github_login ?? row.id,
    label: row.github_login ?? row.id,
  }));
}

export async function listOrganizations(_root: string): Promise<OwnerSummary[]> {
  const { withClient } = await import("@doco/db");
  const r = await withClient((c) =>
    c.query<{ id: string; slug: string; name: string }>(
      "SELECT id, slug, name FROM organizations ORDER BY slug",
    ),
  );
  return r.rows.map((row) => ({
    kind: "organization" as const,
    id: row.id as EntityId<"organization">,
    slug: row.slug,
    display_name: row.name ?? row.slug,
  }));
}

export async function resolveOwnerSlug(root: string, slug: string): Promise<OwnerSummary | null> {
  const [users, orgs] = await Promise.all([listPrincipals(root), listOrganizations(root)]);
  return users.find((p) => p.slug === slug) ?? orgs.find((o) => o.slug === slug) ?? null;
}

/**
 * Slugs that name top-level @doco/web routes — rejected by addPrincipal /
 * addOrganization / createDocoInHost so a User or Org can never collide
 * with the URL routing layer (ADR-067).
 */
export const RESERVED_SLUGS = HOST_RESERVED_SLUGS;

const SLUG_PATTERN = /^[a-z0-9_-]+$/;

function assertSlugAllowed(slug: string, kind: "principal" | "organization" | "doco"): void {
  if (kind === "doco") {
    // Doco handles use the stricter `validateRequestedDocoHandle` from
    // @doco/shared (which also rejects `/` and enforces a length cap).
    const err = validateRequestedDocoHandle(slug);
    if (err) throw new Error(err);
    return;
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(`Invalid ${kind} slug "${slug}" — expected kebab-case [a-z0-9_-]+ (ADR-067).`);
  }
  if (HOST_RESERVED_SLUGS.has(slug)) {
    throw new Error(
      `Slug "${slug}" is reserved by Doco's URL routing (ADR-067). Pick a different name.`,
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────────────────────────────────

export interface AddPrincipalOptions {
  username: string;
  email?: string;
  /** GitHub identity captured by the OAuth callback (ADR-095). Optional only for
   *  tests that don't exercise the OAuth flow; production callers always provide it. */
  github_identity?: {
    github_id: string; // numeric ID from GitHub, stable across login renames
    github_login: string;
    email?: string;
  };
}

/**
 * Look up a Principal by GitHub login. Returns null if not found.
 * Used by the OAuth callback to decide create-vs-sign-in.
 */
export async function findPrincipalByGitHubLogin(
  _root: string,
  githubLogin: string,
): Promise<{ id: EntityId<"principal">; username: string } | null> {
  // Post-rename: lookup by github_login lives on collaborators.
  const { withClient } = await import("@doco/db");
  const r = await withClient((c) =>
    c.query<{ id: string; github_login: string | null }>(
      "SELECT id, github_login FROM collaborators WHERE LOWER(github_login) = LOWER($1) LIMIT 1",
      [githubLogin],
    ),
  );
  if (!r.rows[0]) return null;
  return {
    id: r.rows[0].id as EntityId<"principal">,
    username: r.rows[0].github_login ?? r.rows[0].id,
  };
}

/**
 * Add a new collaborator (OAuth-identity user) to the host. Function
 * name kept for caller compatibility, but post-rename the entity is a
 * Collaborator, not a Principal. Returns the new collaborator id.
 */
export async function addPrincipal(
  _root: string,
  opts: AddPrincipalOptions,
): Promise<EntityId<"collaborator">> {
  assertSlugAllowed(opts.username, "principal");
  const id = makeEntityId("collaborator", generateUlid()) as EntityId<"collaborator">;
  const created = nowIso();
  const gh = opts.github_identity ?? {
    github_login: opts.username,
    ...(opts.email ? { email: opts.email } : {}),
  };
  const collaborator = {
    id,
    kind: "person",
    github_login: gh.github_login,
    ...(gh.email ? { email: gh.email } : {}),
    ...(opts.email && !gh.email ? { email: opts.email } : {}),
    created_at: created,
  };

  const { withClient } = await import("@doco/db");
  await withClient(async (c) => {
    const dup = await c.query(
      `SELECT 1 FROM collaborators WHERE github_login = $1
       UNION
       SELECT 1 FROM principals WHERE username = $1
       UNION
       SELECT 1 FROM organizations WHERE slug = $1
       LIMIT 1`,
      [opts.username],
    );
    if (dup.rows.length > 0) {
      throw new Error(`Slug "${opts.username}" is already taken.`);
    }
    await c.query(
      `INSERT INTO collaborators
        (id, kind, github_login, email, data, created_at, updated_at)
       VALUES ($1, 'person', $2, $3, $4::jsonb, $5, $5)`,
      [
        id,
        gh.github_login ?? opts.username,
        opts.email ?? gh.email ?? null,
        JSON.stringify(collaborator),
        created,
      ],
    );
  });
  // Every collaborator gets a personal Organization with handle =
  // username at sign-up. Idempotent.
  await ensurePersonalOrganization(id, opts.username);
  return id;
}

// ──────────────────────────────────────────────────────────────────────────
// v15 helpers: Organization + Doco creation that key off `handle` /
// `org_id` instead of the legacy `slug` / polymorphic `owner_id`. These
// are additive — the pre-v13 `addOrganization` / `createDocoInHost`
// below still work unchanged.

/**
 * Ensure every Principal has a personal Organization with handle =
 * username. Idempotent: returns the existing org if one already
 * matches, otherwise mints a fresh one and adds the Principal as
 * owner. Safe to call repeatedly (e.g. on every sign-in to backfill
 * older Principals).
 */
export async function ensurePersonalOrganization(
  principalId: string,
  username: string,
): Promise<EntityId<"organization">> {
  const { withClient } = await import("@doco/db");
  return withClient(async (c) => {
    const existing = await c.query<{ id: string }>(
      "SELECT id FROM organizations WHERE handle = $1 OR slug = $1 LIMIT 1",
      [username],
    );
    if (existing.rows[0]) {
      await c.query(
        `INSERT INTO org_users (org_id, collaborator_id, role)
         VALUES ($1, $2, 'owner')
         ON CONFLICT (org_id, collaborator_id) DO NOTHING`,
        [existing.rows[0].id, principalId],
      );
      return existing.rows[0].id as EntityId<"organization">;
    }
    const id = makeEntityId("organization", generateUlid()) as EntityId<"organization">;
    const created = nowIso();
    // The legacy schema still has NOT NULL on slug/name. Populate them
    // with the same handle so the upsert path stays happy.
    await c.query(
      `INSERT INTO organizations (id, slug, name, handle, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6)`,
      [
        id,
        username,
        username,
        username,
        JSON.stringify({
          id,
          handle: username,
          owner_id: principalId,
          created_at: created,
        }),
        created,
      ],
    );
    await c.query(
      `INSERT INTO org_users (org_id, collaborator_id, role, joined_at)
       VALUES ($1, $2, 'owner', $3)`,
      [id, principalId, created],
    );
    return id;
  });
}

/**
 * Find the next available organization handle starting from `requested`.
 * Appends `-2`, `-3`, … until a free slot is found. Organization handles
 * are scoped to organizations: Doco handles live at top-level URLs and
 * principal names are role labels, while org pages live under `/orgs`.
 * Used by both the web suggestion path and the API `autoSuffix` path.
 */
export async function findAvailableOrgHandle(requested: string): Promise<string> {
  const base = requested.trim().toLowerCase();
  if (!base) throw new Error("Organization handle is required.");
  const { withClient } = await import("@doco/db");
  return withClient(async (c) => {
    let candidate = base;
    let n = 2;
    while (true) {
      const taken = await c.query(
        "SELECT 1 FROM organizations WHERE handle = $1 OR slug = $1 LIMIT 1",
        [candidate],
      );
      if (taken.rows.length === 0) return candidate;
      candidate = `${base}-${n}`;
      n += 1;
      if (n > 1000) throw new Error("Could not find an available handle.");
    }
  });
}

/**
 * Compose `<orgHandle>-<requestedSuffix>` and find the next free
 * variant. Used by the web new-doco flow's collision suggestion.
 */
export async function findAvailableDocoHandle(
  orgHandle: string,
  requestedSuffix: string,
): Promise<string> {
  const suffix = requestedSuffix.trim().toLowerCase();
  if (!suffix) throw new Error("Doco suffix is required.");
  const base = `${orgHandle}-${suffix}`;
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

/**
 * Single-property Organization create (v15). Takes just the handle and
 * the owning Principal id. The legacy `addOrganization` (slug +
 * display_name + description) stays for back-compat callers.
 */
export async function addOrganizationByHandle(opts: {
  handle: string;
  ownerPrincipalId: string;
  autoSuffix?: boolean;
}): Promise<{ id: EntityId<"organization">; handle: string }> {
  assertSlugAllowed(opts.handle, "organization");
  const { withClient } = await import("@doco/db");
  const finalHandle = opts.autoSuffix ? await findAvailableOrgHandle(opts.handle) : opts.handle;
  return withClient(async (c) => {
    if (!opts.autoSuffix) {
      const taken = await c.query(
        "SELECT 1 FROM organizations WHERE handle = $1 OR slug = $1 LIMIT 1",
        [finalHandle],
      );
      if (taken.rows.length > 0) {
        throw new Error(`Handle "${finalHandle}" is already taken.`);
      }
    }
    const id = makeEntityId("organization", generateUlid()) as EntityId<"organization">;
    const created = nowIso();
    await c.query(
      `INSERT INTO organizations (id, slug, name, handle, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6)`,
      [
        id,
        finalHandle,
        finalHandle,
        finalHandle,
        JSON.stringify({
          id,
          handle: finalHandle,
          owner_id: opts.ownerPrincipalId,
          created_at: created,
        }),
        created,
      ],
    );
    await c.query(
      `INSERT INTO org_users (org_id, collaborator_id, role, joined_at)
       VALUES ($1, $2, 'owner', $3)`,
      [id, opts.ownerPrincipalId, created],
    );
    return { id, handle: finalHandle };
  });
}

/**
 * Create a Doco owned by an Organization (v15). Composes the doco
 * handle as `<org-handle>-<suffix>` and auto-suffixes on collision
 * when `autoSuffix` is true. The creator becomes `owner` in
 * `doco_users`. Skips filesystem setup; durable state is Postgres-only.
 */
export async function createDocoInOrg(opts: {
  orgId: string;
  requestedSuffix: string;
  createdByPrincipalId: string;
  visibility?: "private" | "public";
  templateHandle?: string | null;
  autoSuffix?: boolean;
}): Promise<{
  docoId: EntityId<"doco">;
  orgId: string;
  orgHandle: string;
  handle: string;
}> {
  const suffix = opts.requestedSuffix.trim().toLowerCase();
  if (!suffix || !/^[a-z0-9][a-z0-9_-]*$/.test(suffix)) {
    throw new Error(
      `Invalid doco suffix "${opts.requestedSuffix}". Must be lowercase kebab-case ([a-z0-9][a-z0-9_-]*).`,
    );
  }
  if (HOST_RESERVED_SLUGS.has(suffix)) {
    throw new Error(`Doco suffix "${suffix}" is reserved by URL routing.`);
  }

  const { withClient } = await import("@doco/db");
  return withClient(async (c) => {
    const orgRow = await c.query<{ id: string; handle: string }>(
      "SELECT id, COALESCE(handle, slug) AS handle FROM organizations WHERE id = $1",
      [opts.orgId],
    );
    if (orgRow.rowCount === 0) {
      throw new Error(`Organization "${opts.orgId}" not found.`);
    }
    const orgHandle = String(orgRow.rows[0]?.handle ?? "");
    if (!orgHandle) {
      throw new Error(`Organization "${opts.orgId}" has no handle.`);
    }

    const baseHandle = `${orgHandle}-${suffix}`;
    let handle = baseHandle;
    {
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
    }

    const docoId = makeEntityId("doco", generateUlid()) as EntityId<"doco">;
    const created = nowIso();
    const visibility = opts.visibility ?? "private";
    const docoYaml = {
      id: docoId,
      handle,
      visibility,
      owner_id: opts.orgId,
      org_id: opts.orgId,
      template_handle: opts.templateHandle ?? null,
      created_at: created,
      created_by: opts.createdByPrincipalId,
      lifecycle: "active",
    };
    // owner_id is still NOT NULL on the legacy schema; populate it
    // alongside org_id so existing readers keep working.
    // v15: template-driven Doco creation. The picked template seeds
    // constitution primitives + sets the doco-level
    // `allowed_neuron_types` and `default_neuron_lifecycle` columns.
    // `generic` (or unknown handle) seeds nothing.
    const template = opts.templateHandle ? findDocoTemplate(opts.templateHandle) : null;
    const allowedNeuronTypes = template?.allowedNeuronTypes ?? null;
    const defaultNeuronLifecycle = template?.defaultNeuronLifecycle ?? null;
    if (allowedNeuronTypes) {
      (docoYaml as Record<string, unknown>).allowed_neuron_types = allowedNeuronTypes;
    }
    if (defaultNeuronLifecycle) {
      (docoYaml as Record<string, unknown>).default_neuron_lifecycle = defaultNeuronLifecycle;
    }
    await c.query(
      `INSERT INTO docos (id, handle, owner_id, org_id, visibility, data,
                          allowed_neuron_types, default_neuron_lifecycle,
                          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $9)`,
      [
        docoId,
        handle,
        opts.orgId,
        opts.orgId,
        visibility,
        JSON.stringify(docoYaml),
        allowedNeuronTypes,
        defaultNeuronLifecycle,
        created,
      ],
    );
    await c.query(
      `INSERT INTO doco_users (doco_id, collaborator_id, role, joined_at)
       VALUES ($1, $2, 'owner', $3)
       ON CONFLICT (doco_id, collaborator_id) DO UPDATE SET role = 'owner'`,
      [docoId, opts.createdByPrincipalId, created],
    );
    // Seed each template primitive as a Constitution Primitive.
    // Prose-only entries become guidance_primitives; predicate-bearing
    // entries become neuron_authoring_primitives. Domain Rule neurons
    // stay available for project/business constraints.
    if (template && template.primitives.length > 0) {
      for (const primitive of template.primitives) {
        const isAuthoring = Boolean(primitive.predicate);
        const firesWhen = Array.isArray(primitive.fires_when_neuron_lifecycle)
          ? primitive.fires_when_neuron_lifecycle
          : [];
        const entityType = isAuthoring ? "neuron_authoring_primitive" : "guidance_primitive";
        const table = isAuthoring ? "neuron_authoring_primitives" : "guidance_primitives";
        const primitiveId = `${entityType}_${generateUlid()}`;
        const primitiveYaml: Record<string, unknown> = {
          id: primitiveId,
          doco_id: docoId,
          primitive_kind: isAuthoring ? "neuron_authoring" : "guidance",
          summary: primitive.summary,
          ...(primitive.predicate
            ? {
                evaluation_kind:
                  primitive.predicate.kind === "probabilistic"
                    ? "probabilistic"
                    : "deterministic",
                predicate: primitive.predicate,
                on_violation: "block",
              }
            : {}),
          ...(firesWhen.length > 0 ? { fires_when_neuron_lifecycle: firesWhen } : {}),
          template_seeded: true,
          template_handle: opts.templateHandle ?? null,
          created_at: created,
          created_by: opts.createdByPrincipalId,
          lifecycle: "active",
        };
        try {
          await c.query(
            `INSERT INTO ${table} (id, doco_id, summary, data, body_md, lifecycle,
                                created_at, updated_at, created_by, updated_by)
             VALUES ($1, $2, $3, $4::jsonb, $5, 'active', $6, $6, $7, $7)`,
            [
              primitiveId,
              docoId,
              primitive.summary,
              JSON.stringify(primitiveYaml),
              primitive.body_md ?? "",
              created,
              opts.createdByPrincipalId,
            ],
          );
        } catch {
          // ignore — one bad primitive shouldn't fail the doco create.
        }
      }
    }

    // Attach the two ship-by-default visualization perspectives (graph
    // is the default tab, list is position 1). Templates may also
    // declare additional perspectives — those land at the end. A
    // template entry with `isDefault: true` overrides the graph
    // default. Failures are non-fatal; the index loader's
    // `ensureDefaultsAttached` will paper over a missing attach on
    // first read.
    try {
      const extraPerspectives = template?.perspectives ?? [];
      const templateDefault = extraPerspectives.find((p) => p.isDefault) ?? null;
      const graphIsDefault = !templateDefault;
      await c.query(
        `INSERT INTO doco_perspectives (doco_id, perspective_id, position, is_default, attached_at, attached_by_collaborator)
              VALUES ($1, 'perspective_graph', 0, $2, $3, $4)
         ON CONFLICT (doco_id, perspective_id) DO NOTHING`,
        [docoId, graphIsDefault, created, opts.createdByPrincipalId],
      );
      await c.query(
        `INSERT INTO doco_perspectives (doco_id, perspective_id, position, is_default, attached_at, attached_by_collaborator)
              VALUES ($1, 'perspective_list', 1, false, $2, $3)
         ON CONFLICT (doco_id, perspective_id) DO NOTHING`,
        [docoId, created, opts.createdByPrincipalId],
      );
      let position = 2;
      for (const entry of extraPerspectives) {
        const { rows: pRows } = await c.query<{ id: string }>(
          `SELECT id FROM perspectives WHERE slug = $1`,
          [entry.slug],
        );
        const perspectiveId = pRows[0]?.id;
        if (!perspectiveId) continue;
        const isDefault = templateDefault?.slug === entry.slug;
        await c.query(
          `INSERT INTO doco_perspectives (doco_id, perspective_id, position, is_default, attached_at, attached_by_collaborator)
                VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (doco_id, perspective_id) DO NOTHING`,
          [docoId, perspectiveId, position, isDefault, created, opts.createdByPrincipalId],
        );
        position += 1;
      }
    } catch (err) {
      // Best-effort — log but don't fail Doco creation. The lazy
      // ensureDefaultsAttached on first index load will recover the
      // graph + list defaults if this block silently failed.
      console.warn(
        `[doco-host] failed to attach perspectives to ${docoId}:`,
        (err as Error).message,
      );
    }
    return { docoId, orgId: opts.orgId, orgHandle, handle };
  });
}

/**
 * Doco-template lookup. Templates are stored under plain handles
 * (`global`, `user-flows`, `state-machines`, `business-processes`).
 * Strips a leading `#` from input for backwards compat with older
 * clients that still pass hashtag-shaped handles, and keeps the
 * `global-rules` legacy alias mapping to `global`.
 */
export function findDocoTemplate(handle: string): DocoTemplate | null {
  const stripped = handle.startsWith("#") ? handle.slice(1) : handle;
  const aliased: Record<string, string> = { "global-rules": "global" };
  const lookup = aliased[stripped] ?? stripped;
  return DEFAULT_DOCO_TEMPLATES.find((tpl) => tpl.name === lookup) ?? null;
}

export interface AddOrganizationOptions {
  slug: string;
  display_name?: string;
  description?: string;
  ownerUsername: string; // who owns the org
  visibility?: "private" | "public";
}

export async function addOrganization(
  root: string,
  opts: AddOrganizationOptions,
): Promise<EntityId<"organization">> {
  assertSlugAllowed(opts.slug, "organization");
  const owner = await resolveOwnerSlug(root, opts.ownerUsername);
  if (!owner || owner.kind !== "principal") {
    throw new Error(`Owner "${opts.ownerUsername}" not found as a User in this host.`);
  }
  const id = makeEntityId("organization", generateUlid()) as EntityId<"organization">;
  const created = nowIso();
  const yaml: Organization = {
    id,
    doco_id: `doco_${generateUlid()}` as EntityId<"doco">,
    summary: `Organization ${opts.slug}.`,
    slug: opts.slug,
    display_name: opts.display_name ?? opts.slug,
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    visibility: opts.visibility ?? "private",
    members: [
      {
        collaborator_id: owner.id as unknown as EntityId<"collaborator">,
        role: "owner",
        permissions: ["read", "write", "execute", "admin"],
      },
    ],
    created_at: created,
    created_by: owner.id as unknown as EntityId<"collaborator">,
    lifecycle: "active",
  };

  const { withClient } = await import("@doco/db");
  await withClient(async (c) => {
    const dup = await c.query(
      `SELECT 1 FROM organizations WHERE slug = $1
       UNION
       SELECT 1 FROM principals WHERE username = $1
       LIMIT 1`,
      [opts.slug],
    );
    if (dup.rows.length > 0) throw new Error(`Slug "${opts.slug}" is already taken.`);
    await c.query(
      `INSERT INTO organizations (id, slug, name, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $5)`,
      [id, opts.slug, opts.display_name ?? opts.slug, JSON.stringify(yaml), created],
    );
    await c.query(
      `INSERT INTO org_users (org_id, collaborator_id, role, joined_at)
       VALUES ($1, $2, 'owner', $3)`,
      [id, owner.id, created],
    );
  });
  return id;
}

// ──────────────────────────────────────────────────────────────────────────
// docos in a host
// ──────────────────────────────────────────────────────────────────────────

export interface CreateDocoInHostOptions {
  ownerSlug: string; // resolves to user or org
  docoSlug: string;
  /** Optional preallocated id for flows that derive related identity from the final Doco id. */
  docoId?: EntityId<"doco">;
  /**
   * Phase 1 of slug-removal: caller's preferred human-readable id for
   * the new Doco. Optional — when omitted, the handle is generated as
   * `<ownerSlug>-<docoSlug>` (the same shape the migration uses for
   * pre-existing rows). On collision with another row's handle (and
   * only when `autoSuffixOnCollision` is true) the host appends `-2`,
   * `-3`, … until a free id is found.
   */
  requestedId?: string;
  visibility?: "private" | "public";
  /**
   * If true and `docoSlug` is already taken, silently try `<slug>-2`,
   * `<slug>-3`, … until a free slot is found and create there. The
   * actually-used slug comes back on the returned record.
   */
  autoSuffixOnCollision?: boolean;
}

export interface DocoRecord {
  ownerSlug: string;
  docoSlug: string;
  /** Phase 1 of slug-removal: globally-unique human-readable URL id. */
  handle: string;
  ownerKind: "principal" | "organization";
  ownerId: EntityId<"principal"> | EntityId<"organization">;
  docoId: EntityId<"doco">;
  path: string;
}

function normalizeHandleCandidate(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 64);
}

export async function createDocoInHost(
  root: string,
  opts: CreateDocoInHostOptions,
): Promise<DocoRecord> {
  assertSlugAllowed(opts.docoSlug, "doco");
  const owner = await resolveOwnerSlug(root, opts.ownerSlug);
  if (!owner) {
    throw new Error(`Owner "${opts.ownerSlug}" not found in this host.`);
  }

  const { withClient } = await import("@doco/db");
  const docoSlug = opts.docoSlug;

  // requested_id wins; otherwise fall back to `<owner>-<slug>`.
  const baseHandle =
    normalizeHandleCandidate(opts.requestedId ?? `${opts.ownerSlug}-${docoSlug}`) ||
    `${opts.ownerSlug}-${docoSlug}`;
  const handleErr = validateRequestedDocoHandle(baseHandle);
  if (handleErr) throw new Error(handleErr);
  let handle = baseHandle;
  {
    const firstDup = await withClient((c) =>
      c.query("SELECT 1 FROM docos WHERE handle = $1 LIMIT 1", [handle]),
    );
    if (firstDup.rows.length > 0) {
      if (!opts.autoSuffixOnCollision) {
        throw new Error(`Doco "${baseHandle}" already exists.`);
      }
      let n = 2;
      while (true) {
        handle = `${baseHandle}-${n}`;
        const dup = await withClient((c) =>
          c.query("SELECT 1 FROM docos WHERE handle = $1 LIMIT 1", [handle]),
        );
        if (dup.rows.length === 0) break;
        n++;
        if (n > 999) {
          throw new Error(
            `Auto-suffix exhausted: handle "${baseHandle}-2" through "-999" are all taken.`,
          );
        }
      }
    }
  }

  const docoId = opts.docoId ?? (makeEntityId("doco", generateUlid()) as EntityId<"doco">);
  const created = nowIso();
  const docoYaml = {
    id: docoId,
    handle,
    display_name: handle,
    visibility: opts.visibility ?? "private",
    default_branch: "main",
    owner_id: owner.id,
    summary: `Created in host on ${created}.`,
    created_at: created,
    created_by: owner.kind === "principal" ? owner.id : null,
    lifecycle: "active",
    members:
      owner.kind === "principal"
        ? [
            {
              collaborator_id: owner.id,
              role: "owner",
              permissions: ["read", "write", "execute", "admin"],
            },
          ]
        : [],
    imports: [] as unknown[],
  };
  await withClient((c) =>
    c.query(
      `INSERT INTO docos (id, handle, owner_id, name, visibility, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $7)`,
      [
        docoId,
        handle,
        owner.id,
        docoSlug,
        opts.visibility ?? "private",
        JSON.stringify(docoYaml),
        created,
      ],
    ),
  );

  // Stamp the creator as the owner in `doco_users` so downstream
  // role + listing queries find them. `listDocoIdsForCollaborator`
  // (used by the OAuth authorize page + the dashboard's "your docos"
  // panel) reads from this table, not from `docos.owner_id` — a fresh
  // creator who isn't grandfathered in by the v8 backfill is otherwise
  // invisible to those queries. Org-owned docos rely on org_users for
  // role resolution instead, so we only add a per-principal row when
  // the owner is itself a principal.
  if (owner.kind === "principal") {
    await withClient((c) =>
      c.query(
        `INSERT INTO doco_users (doco_id, collaborator_id, role)
         VALUES ($1, $2, 'owner')
         ON CONFLICT (doco_id, collaborator_id) DO UPDATE SET role = 'owner'`,
        [docoId, owner.id],
      ),
    );
  }

  return {
    ownerSlug: opts.ownerSlug,
    docoSlug,
    handle,
    ownerKind: owner.kind,
    ownerId: owner.id,
    docoId,
    path: hostDocoDir(root, opts.ownerSlug, docoSlug),
  };
}

/**
 * Apply a partial update to a Doco's metadata (settings page) by
 * UPDATEing the Postgres row + `data`.
 *
 *   - Each field undefined → leave it alone.
 *   - display_name: empty string clears the key.
 *   - visibility: only "private" or "public" accepted; other values rejected.
 *
 * Caller is expected to reindex.
 */
export interface UpdateDocoOptions {
  handle: string;
  display_name?: string | null;
  visibility?: "private" | "public";
}

export async function updateDocoMeta(opts: UpdateDocoOptions): Promise<void> {
  if (
    opts.visibility !== undefined &&
    opts.visibility !== "private" &&
    opts.visibility !== "public"
  ) {
    throw new Error(`visibility must be "private" or "public", got: ${opts.visibility}`);
  }
  const { handle } = opts;
  const { withClient } = await import("@doco/db");
  await withClient(async (c) => {
    const cur = await c.query<{ data: Record<string, unknown> | null }>(
      "SELECT data FROM docos WHERE handle = $1 LIMIT 1",
      [handle],
    );
    if (!cur.rows[0]) throw new Error(`Doco "${handle}" not found.`);
    const yaml: Record<string, unknown> = { ...(cur.rows[0].data ?? {}) };
    if (opts.display_name !== undefined) {
      if (opts.display_name === null || opts.display_name === "") yaml.display_name = undefined;
      else yaml.display_name = opts.display_name;
    }
    if (opts.visibility !== undefined) yaml.visibility = opts.visibility;
    await c.query(
      `UPDATE docos
          SET name       = $2,
              visibility = COALESCE($3, visibility),
              data       = $4::jsonb,
              updated_at = now()
        WHERE handle = $1`,
      [
        handle,
        (yaml.display_name as string | undefined) ?? null,
        opts.visibility ?? null,
        JSON.stringify(yaml),
      ],
    );
  });
}

/**
 * Rename a Doco's handle. The handle is what appears in every URL —
 * `/<handle>/...` — so this update changes every link to the Doco.
 */
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
    const yaml: Record<string, unknown> = { ...(cur.rows[0].data ?? {}) };
    yaml.handle = newHandle;
    await c.query(
      `UPDATE docos
          SET handle     = $2,
              data       = $3::jsonb,
              updated_at = now()
        WHERE handle = $1`,
      [oldHandle, newHandle, JSON.stringify(yaml)],
    );
  });
}

/**
 * Delete a Doco. This is a hard delete — `ON DELETE CASCADE` removes
 * every entity and edge tied to the Doco.
 */
export async function softDeleteDoco(opts: {
  root: string;
  ownerSlug: string;
  docoSlug: string;
}): Promise<{ deletedPath: string }> {
  const { ownerSlug, docoSlug } = opts;
  const handle = `${ownerSlug}-${docoSlug}`;
  const { withClient } = await import("@doco/db");
  const result = await withClient((c) =>
    c.query("DELETE FROM docos WHERE handle = $1 RETURNING id", [handle]),
  );
  if (result.rowCount === 0) {
    throw new Error(`Doco "${handle}" not found.`);
  }
  return { deletedPath: `postgres:docos/${handle}` };
}

export async function listDocos(root: string): Promise<DocoRecord[]> {
  const { withClient } = await import("@doco/db");
  // Post-rename: doco.owner_id is collaborator_<ulid> or organization_<ulid>.
  // Owner-slug derives from collaborators.github_login or organizations.slug.
  const r = await withClient((c) =>
    c.query<{ id: string; handle: string; owner_slug: string; owner_id: string }>(
      `SELECT d.id, d.handle, d.owner_id,
              COALESCE(c.github_login, o.slug, '') AS owner_slug
         FROM docos d
         LEFT JOIN collaborators c ON c.id = d.owner_id
         LEFT JOIN organizations o ON o.id = d.owner_id
        ORDER BY d.handle`,
    ),
  );
  return r.rows.map((row) => ({
    ownerSlug: row.owner_slug,
    docoSlug: row.handle,
    handle: row.handle,
    ownerKind: row.owner_id.startsWith("organization_") ? "organization" : "principal",
    ownerId: row.owner_id as EntityId<"principal"> | EntityId<"organization">,
    docoId: row.id as EntityId<"doco">,
    path: hostDocoDir(root, row.owner_slug, row.handle),
  }));
}
