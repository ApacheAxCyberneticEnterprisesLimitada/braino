import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type AuthoringPredicate,
  type EntityId,
  type Organization,
  type Principal,
  generateUlid,
  makeEntityId,
  nowIso,
  HOST_RESERVED_SLUGS,
  validateDocoSlug,
  validateRequestedDocoId,
} from "@doco/shared";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  detectMode,
  hostDocoDir,
  hostDocosDir,
  hostOrganizationsDir,
  hostPrincipalsDir,
  hostYamlPath,
} from "./mode.js";
import {
  DEFAULT_SCOPE_TEMPLATES,
  type ScopeTemplate,
} from "./scope-templates.js";

export interface HostConfig {
  id: string; // host_<ulid> — meta-Doco style
  schema_version: string;
  name: string;
  created_at: string;
  created_by: EntityId<"principal"> | null;
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
): Promise<{ host: HostConfig; bootstrapPrincipalId: EntityId<"principal"> | null }> {
  if (detectMode(root) !== "empty") {
    throw new Error(`Refusing to overwrite: ${root} is already a Host or Doco.`);
  }
  await mkdir(root, { recursive: true });
  await mkdir(hostPrincipalsDir(root), { recursive: true });
  await mkdir(hostOrganizationsDir(root), { recursive: true });
  await mkdir(hostDocosDir(root), { recursive: true });

  // Optional bootstrap Principal.
  let bootstrapId: EntityId<"principal"> | null = null;
  if (opts.ownerUsername) {
    const created = nowIso();
    const id = makeEntityId("principal", generateUlid()) as EntityId<"principal">;
    const principal: Principal = {
      id,
      // host bootstrap: principals at host level live without a single doco_id;
      // we synthesize a host self-id below for the schema's required field.
      doco_id: ("doco_" + generateUlid()) as EntityId<"doco">,
      node_type: "principal",
      summary: `Host owner ${opts.ownerUsername}.`,
      type: "person",
      username: opts.ownerUsername,
      display_name: opts.ownerUsername,
      ...(opts.ownerEmail
        ? { github_identity: { github_login: opts.ownerUsername, email: opts.ownerEmail } }
        : { github_identity: { github_login: opts.ownerUsername } }),
      created_at: created,
      created_by: id,
      lifecycle: "active",
      scopes: [],
    };
    await writeFile(
      join(hostPrincipalsDir(root), `${id}.yaml`),
      stringifyYaml(principal),
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
    `# ${opts.name}\n\nA multi-tenant Doco Host. See [ADR-061](https://example.invalid).\n\n` +
      "## Quick start\n\n" +
      "```bash\ndoco host user create alice\ndoco host org create my-org --owner alice\ndoco host doco new alice/my-doco\ndoco host list\n```\n",
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
  | { kind: "principal"; id: EntityId<"principal">; slug: string; display_name: string }
  | { kind: "organization"; id: EntityId<"organization">; slug: string; display_name: string };

export async function listPrincipals(_root: string): Promise<OwnerSummary[]> {
  const { withClient } = await import("@doco/db");
  const r = await withClient((c) =>
    c.query<{ id: string; username: string }>(
      "SELECT id, username FROM principals WHERE deactivated_at IS NULL ORDER BY username",
    ),
  );
  return r.rows.map((row) => ({
    kind: "principal" as const,
    id: row.id as EntityId<"principal">,
    slug: row.username,
    display_name: row.username,
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
    // Doco slugs use the stricter `validateDocoSlug` from @doco/shared
    // (which also rejects `/` and enforces a length cap).
    const err = validateDocoSlug(slug);
    if (err) throw new Error(err);
    return;
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `Invalid ${kind} slug "${slug}" — expected kebab-case [a-z0-9_-]+ (ADR-067).`,
    );
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
  /** Deprecated for human users: username is the display label. */
  display_name?: string;
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
  const { withClient } = await import("@doco/db");
  const r = await withClient((c) =>
    c.query<{ id: string; username: string }>(
      "SELECT id, username FROM principals WHERE LOWER(github_login) = LOWER($1) LIMIT 1",
      [githubLogin],
    ),
  );
  if (!r.rows[0]) return null;
  return {
    id: r.rows[0].id as EntityId<"principal">,
    username: r.rows[0].username,
  };
}

export async function addPrincipal(
  _root: string,
  opts: AddPrincipalOptions,
): Promise<EntityId<"principal">> {
  const id = makeEntityId("principal", generateUlid()) as EntityId<"principal">;
  const created = nowIso();
  const gh = opts.github_identity ?? {
    github_login: opts.username,
    ...(opts.email ? { email: opts.email } : {}),
  };
  const yaml: Principal = {
    id,
    doco_id: ("doco_" + generateUlid()) as EntityId<"doco">,
    node_type: "principal",
    summary: `User ${opts.username}.`,
    type: "person",
    username: opts.username,
    display_name: opts.username,
    github_identity: gh,
    created_at: created,
    created_by: id,
    lifecycle: "active",
    scopes: [],
  };

  const { withClient } = await import("@doco/db");
  await withClient(async (c) => {
    const dup = await c.query(
      "SELECT 1 FROM principals WHERE username = $1 LIMIT 1",
      [opts.username],
    );
    if (dup.rows.length > 0) {
      throw new Error(`Slug "${opts.username}" is already taken.`);
    }
    await c.query(
      `INSERT INTO principals
        (id, username, type, display_name, email, github_login, avatar_url, owner_id, raw_yaml, created_at, updated_at, deactivated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, NULL)`,
      [
        id,
        opts.username,
        "human",
        opts.username,
        opts.email ?? null,
        gh.github_login ?? null,
        null,
        null,
        JSON.stringify(yaml),
        created,
      ],
    );
  });
  return id;
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
  const owner = await resolveOwnerSlug(root, opts.ownerUsername);
  if (!owner || owner.kind !== "principal") {
    throw new Error(`Owner "${opts.ownerUsername}" not found as a User in this host.`);
  }
  const id = makeEntityId("organization", generateUlid()) as EntityId<"organization">;
  const created = nowIso();
  const yaml: Organization = {
    id,
    doco_id: ("doco_" + generateUlid()) as EntityId<"doco">,
    node_type: "organization",
    summary: `Organization ${opts.slug}.`,
    slug: opts.slug,
    display_name: opts.display_name ?? opts.slug,
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    visibility: opts.visibility ?? "private",
    members: [
      {
        principal_id: owner.id,
        role: "owner",
        permissions: ["read", "write", "execute", "admin"],
      },
    ],
    created_at: created,
    created_by: owner.id,
    lifecycle: "active",
    scopes: [],
  };

  const { withClient } = await import("@doco/db");
  await withClient(async (c) => {
    const dup = await c.query("SELECT 1 FROM organizations WHERE slug = $1 LIMIT 1", [opts.slug]);
    if (dup.rows.length > 0) throw new Error(`Slug "${opts.slug}" is already taken.`);
    await c.query(
      `INSERT INTO organizations (id, slug, name, raw_yaml, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [id, opts.slug, opts.display_name ?? opts.slug, JSON.stringify(yaml), created],
    );
    await c.query(
      `INSERT INTO org_members (org_id, principal_id, role, joined_at)
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
  description?: string;
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
  const handleErr = validateRequestedDocoId(baseHandle);
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
    node_type: "doco",
    handle,
    display_name: handle,
    visibility: opts.visibility ?? "private",
    default_branch: "main",
    owner_id: owner.id,
    description:
      opts.description ?? `Doco created in host (owned by ${owner.kind} "${opts.ownerSlug}").`,
    summary: `Created in host on ${created}.`,
    created_at: created,
    created_by: owner.kind === "principal" ? owner.id : null,
    lifecycle: "active",
    scopes: [] as string[],
    members:
      owner.kind === "principal"
        ? [{ principal_id: owner.id, role: "owner", permissions: ["read", "write", "execute", "admin"] }]
        : [],
    imports: [] as unknown[],
  };
  await withClient((c) =>
    c.query(
      `INSERT INTO docos (id, handle, owner_id, name, visibility, raw_yaml, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
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

  const createdBy = owner.kind === "principal" ? owner.id : null;
  // Auto-install every template flagged `auto_install: true` — keeps
  // the install set evolvable without name-driven branching here
  // (Global rule_01KRRVPBS07HDBCXY6TJ5A5TAT). Seed order follows
  // DEFAULT_SCOPE_TEMPLATES array order.
  for (const template of DEFAULT_SCOPE_TEMPLATES) {
    if (!template.auto_install) continue;
    const scopeId = await createScopeInDoco({
      docoDir: hostDocoDir(root, opts.ownerSlug, docoSlug),
      docoId,
      name: template.name,
      icon: template.icon,
      watched: template.auto_install_watched ?? false,
      createdBy,
    });
    await seedScopeFromTemplate({
      docoDir: hostDocoDir(root, opts.ownerSlug, docoSlug),
      docoId,
      scopeId,
      template,
      createdBy,
    });
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
 * Write a Scope entity into a Doco. Per ADR-080 (creation flow), ADR-081
 * (edge hierarchy), and decision_01KRPRDR1AD7S1RP6E69BQDB2G (rules are
 * first-class Rule entities, not embedded arrays on the scope).
 *
 * Names are flat tokens; parent scopes go in the `scopes` array. To express
 * `country/france/payment`, create three scopes — `country`, `france` (with
 * `scopes: [country.id]`), `payment` (with `scopes: [france.id]`).
 *
 * Rules are attached separately via `createRuleInDoco` (with `kind:
 * authoring | guidance | tagged`) tagged `in_scope_of` to the scope.
 */
export interface CreateScopeOptions {
  docoDir: string;
  docoId: EntityId<"doco">;
  name: string;
  /** Single emoji used to identify this scope at a glance. Optional. */
  icon?: string;
  /** Parent scopes — semantically "this scope belongs to those." (ADR-081) */
  parentScopes?: EntityId<"scope">[];
  /**
   * Whether this scope is "watched" — a soft attention signal for
   * contributors (person or agent). When authoring a node, scan against
   * watched scopes and tag the new node into any that fit. Stored as
   * `watched: true` on the scope's own YAML. NOT enforced at capture
   * time — hard enforcement belongs in Global authoring rules (including
   * `mandatory_scope` when every node must list a scope). Required on
   * every scope creation — no default — so the choice is always explicit.
   */
  watched: boolean;
  createdBy: EntityId<"principal"> | null;
}

export async function createScopeInDoco(
  opts: CreateScopeOptions,
): Promise<EntityId<"scope">> {
  const id = makeEntityId("scope", generateUlid()) as EntityId<"scope">;
  const created = nowIso();
  // Fifth framework-native behavior of the Global scope
  // (decision_01KRKS5H2A5QER84CJ8R4VD36Z, rule_01KRKS60A11YEWDASBT6V3HTE9;
  // renamed from "constitution" per decision_01KRPNZY7W6CCMYNKGND67BP0B,
  // then again from "global" → "#global" per the hashtag-name shift):
  // it is always watched and cannot be unwatched. Force watched=true
  // for any scope named "#global" regardless of the caller's input.
  const watched = opts.name === "#global" ? true : opts.watched;
  const yaml: Record<string, unknown> = {
    id,
    doco_id: opts.docoId,
    node_type: "scope",
    summary: `Scope: ${opts.name}`,
    name: opts.name,
    ...(opts.icon ? { icon: opts.icon } : {}),
    created_at: created,
    created_by: opts.createdBy,
    lifecycle: "active",
    scopes: opts.parentScopes ?? [],
    ...(watched ? { watched: true } : {}),
  };
  const { withClient } = await import("@doco/db");
  await withClient((c) =>
    c.query(
      `INSERT INTO scopes (id, doco_id, name, summary, lifecycle, raw_yaml, created_at, updated_at, created_by, updated_by)
       VALUES ($1, $2, $3, $4, 'active', $5, $6, $6, $7, $7)`,
      // raw_yaml is JSON (not YAML) for every other entity type
      // (capture.server.ts:72); standardize scope writes too so
      // loadDoco.ts's JSON.parse doesn't choke on reindex.
      [id, opts.docoId, opts.name, yaml.summary as string, JSON.stringify(yaml), created, opts.createdBy],
    ),
  );
  return id;
}

/**
 * Insert a Rule entity tagged with a scope. Per
 * decision_01KRPRDR1AD7S1RP6E69BQDB2G the framework seeds the Global
 * scope's standing rules this way (one Rule entity per rule + an
 * in_scope_of edge); other callers (the prose classifier endpoint,
 * scope-rule add-via-UI) use the same helper.
 */
export interface CreateRuleOptions {
  docoId: EntityId<"doco">;
  /**
   * Rule kind on the seeded entity. v7
   * (decision_01KRRR5BQ16ASY8HQEE0V499YG) dropped "authoring" — a Rule
   * gates a Scope iff the Scope cites it via `gated_by`, not via a
   * flag on the Rule. Defaults to "tagged" when a predicate is set,
   * "guidance" otherwise (callers can override).
   */
  kind?: "guidance" | "tagged";
  /** One-line readable description. For rules with a predicate this is the prose alongside the structured check. */
  summary: string;
  /** Optional markdown body. */
  body_md?: string;
  /** Optional engine-readable predicate. When present, the seeder
   * writes this Rule's id into the scope's `gated_by` so the engine
   * fires it as an authoring rule for that scope. */
  predicate?: unknown;
  /** v7: when set, the engine only fires this rule against candidates whose lifecycle is in the list. */
  fires_when_node_lifecycle?: import("@doco/shared").Lifecycle[];
  /** The scope this rule is tagged with (in_scope_of edge target). */
  scopeId: EntityId<"scope">;
  /** Initial lifecycle. Defaults to "active". */
  lifecycle?: "active" | "proposed" | "abandoned" | "superseded" | "drafted";
  createdBy: EntityId<"principal"> | null;
}

export async function createRuleInDoco(
  opts: CreateRuleOptions,
): Promise<EntityId<"rule">> {
  const id = makeEntityId("rule", generateUlid()) as EntityId<"rule">;
  const created = nowIso();
  const lifecycle = opts.lifecycle ?? "active";
  // v7: derive kind. "tagged" for rules with predicates, "guidance"
  // for prose-only — the engine reads gated_by, not the kind value.
  const kind = opts.kind ?? (opts.predicate ? "tagged" : "guidance");
  const yaml: Record<string, unknown> = {
    id,
    doco_id: opts.docoId,
    node_type: "rule",
    summary: opts.summary,
    kind,
    ...(opts.predicate ? { predicate: opts.predicate } : {}),
    ...(Array.isArray(opts.fires_when_node_lifecycle) &&
    opts.fires_when_node_lifecycle.length > 0
      ? { fires_when_node_lifecycle: opts.fires_when_node_lifecycle }
      : {}),
    created_at: created,
    created_by: opts.createdBy,
    lifecycle,
    scopes: [opts.scopeId],
    ...(opts.body_md ? { body_md: opts.body_md } : {}),
  };
  const { withClient } = await import("@doco/db");
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO rules (id, doco_id, summary, raw_yaml, body_md, lifecycle, created_at, updated_at, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $8)`,
      [
        id,
        opts.docoId,
        opts.summary,
        JSON.stringify(yaml),
        opts.body_md ?? "",
        lifecycle,
        created,
        opts.createdBy,
      ],
    );
    await c.query(
      `INSERT INTO edges (doco_id, from_id, from_node_type, to_id, to_node_type, edge_type)
       VALUES ($1, $2, 'rule', $3, 'scope', 'in_scope_of')
       ON CONFLICT DO NOTHING`,
      [opts.docoId, id, opts.scopeId],
    );
    // v7: when the rule has a predicate, citing scope ⇒ append rule id
    // to scope.gated_by. The citation IS the authoring-rule marker.
    if (opts.predicate) {
      const cur = await c.query<{ raw_yaml: string }>(
        "SELECT raw_yaml FROM scopes WHERE id = $1 LIMIT 1",
        [opts.scopeId],
      );
      if (cur.rows[0]) {
        let fm: Record<string, unknown> = {};
        try {
          fm = JSON.parse(cur.rows[0].raw_yaml) as Record<string, unknown>;
        } catch {
          try {
            fm = parseYaml(cur.rows[0].raw_yaml) as Record<string, unknown>;
          } catch {
            fm = {};
          }
        }
        const existing = Array.isArray(fm.gated_by)
          ? (fm.gated_by as unknown[]).filter((v): v is string => typeof v === "string")
          : [];
        if (!existing.includes(id)) {
          fm.gated_by = [...existing, id];
          await c.query(
            "UPDATE scopes SET raw_yaml = $1, updated_at = now() WHERE id = $2",
            [JSON.stringify(fm), opts.scopeId],
          );
        }
      }
    }
  });
  return id;
}

/**
 * Insert an Intent entity tagged with a scope. Used by the install flow
 * to seed each template's `intentSummary` as a real Intent at the moment
 * the scope is created (Doco creation for `global`, scope-picker click
 * for `user-flows`). The Intent then lives in the Doco like any other —
 * editable, deprecatable, can be referenced by Decisions via
 * `intent_ids`.
 */
export interface CreateIntentOptions {
  docoId: EntityId<"doco">;
  /** One-line readable description of the stakeholder outcome. */
  summary: string;
  /** Optional markdown body. */
  body_md?: string;
  /** The scope this Intent is tagged with (in_scope_of edge target). */
  scopeId: EntityId<"scope">;
  /** Initial lifecycle. Defaults to "active". */
  lifecycle?: "active" | "proposed" | "abandoned" | "superseded";
  createdBy: EntityId<"principal"> | null;
}

export async function createIntentInDoco(
  opts: CreateIntentOptions,
): Promise<EntityId<"intent">> {
  const id = makeEntityId("intent", generateUlid()) as EntityId<"intent">;
  const created = nowIso();
  const lifecycle = opts.lifecycle ?? "active";
  const yaml: Record<string, unknown> = {
    id,
    doco_id: opts.docoId,
    node_type: "intent",
    summary: opts.summary,
    created_at: created,
    created_by: opts.createdBy,
    lifecycle,
    scopes: [opts.scopeId],
    ...(opts.body_md ? { body_md: opts.body_md } : {}),
  };
  const { withClient } = await import("@doco/db");
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO intents (id, doco_id, summary, raw_yaml, body_md, lifecycle, created_at, updated_at, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $8)`,
      [
        id,
        opts.docoId,
        opts.summary,
        JSON.stringify(yaml),
        opts.body_md ?? "",
        lifecycle,
        created,
        opts.createdBy,
      ],
    );
    await c.query(
      `INSERT INTO edges (doco_id, from_id, from_node_type, to_id, to_node_type, edge_type)
       VALUES ($1, $2, 'intent', $3, 'scope', 'in_scope_of')
       ON CONFLICT DO NOTHING`,
      [opts.docoId, id, opts.scopeId],
    );
  });
  return id;
}

/**
 * Seed a newly-created scope with the entities the framework promises
 * the project owner on install. Every template gets one Intent from
 * `template.intentSummary` plus N Rules from `template.rules`.
 */
export async function seedScopeFromTemplate(opts: {
  docoDir: string;
  docoId: EntityId<"doco">;
  scopeId: EntityId<"scope">;
  template: ScopeTemplate;
  createdBy: EntityId<"principal"> | null;
}): Promise<{ intentId?: EntityId<"intent">; ruleIds: EntityId<"rule">[] }> {
  let intentId: EntityId<"intent"> | undefined;
  if (opts.template.intentSummary.trim()) {
    intentId = await createIntentInDoco({
      docoId: opts.docoId,
      summary: opts.template.intentSummary.trim(),
      scopeId: opts.scopeId,
      createdBy: opts.createdBy,
    });
    await updateScopeInDoco({
      docoDir: opts.docoDir,
      scopeId: opts.scopeId,
      intentIds: [intentId],
    });
  }
  const ruleIds: EntityId<"rule">[] = [];
  for (const r of opts.template.rules) {
    const summary = r.summary.trim();
    if (!summary) continue;
    const id = await createRuleInDoco({
      docoId: opts.docoId,
      ...(r.kind ? { kind: r.kind } : {}),
      summary,
      ...(r.predicate ? { predicate: r.predicate } : {}),
      ...(r.fires_when_node_lifecycle
        ? { fires_when_node_lifecycle: r.fires_when_node_lifecycle }
        : {}),
      ...(r.body_md ? { body_md: r.body_md } : {}),
      scopeId: opts.scopeId,
      createdBy: opts.createdBy,
    });
    ruleIds.push(id);
  }
  // v7: stamp template's default_node_lifecycle onto the scope.
  if (opts.template.default_node_lifecycle) {
    const { withClient } = await import("@doco/db");
    await withClient(async (c) => {
      const cur = await c.query<{ raw_yaml: string }>(
        "SELECT raw_yaml FROM scopes WHERE id = $1 LIMIT 1",
        [opts.scopeId],
      );
      if (!cur.rows[0]) return;
      let fm: Record<string, unknown> = {};
      try {
        fm = JSON.parse(cur.rows[0].raw_yaml) as Record<string, unknown>;
      } catch {
        try {
          fm = parseYaml(cur.rows[0].raw_yaml) as Record<string, unknown>;
        } catch {
          return;
        }
      }
      fm.default_node_lifecycle = opts.template.default_node_lifecycle;
      await c.query(
        "UPDATE scopes SET raw_yaml = $1, updated_at = now() WHERE id = $2",
        [JSON.stringify(fm), opts.scopeId],
      );
    });
  }
  return intentId ? { intentId, ruleIds } : { ruleIds };
}

/**
 * Toggle a scope's "watched" flag — a soft attention signal for
 * contributors. Sets `watched: true` on the scope's own YAML, or removes
 * the key when set to false. Idempotent in both directions.
 *
 * Unlike the `mandatory_scope` Constitution rule mechanism (a hard
 * enforcement that blocks capture), this is a pure metadata flag.
 * Agents and people surface it in their authoring UX so the project's
 * "topics worth tracking" stays visible at capture time.
 */
export async function setScopeWatchedInDoco(opts: {
  docoDir: string;
  targetScopeId: EntityId<"scope">;
  watched: boolean;
}): Promise<void> {
  const { withClient } = await import("@doco/db");
  await withClient(async (c) => {
    const cur = await c.query<{ raw_yaml: string; name: string }>(
      "SELECT raw_yaml, name FROM scopes WHERE id = $1 LIMIT 1",
      [opts.targetScopeId],
    );
    if (!cur.rows[0]) throw new Error(`Scope not found: ${opts.targetScopeId}`);
    if (cur.rows[0].name === "#global" && opts.watched === false) {
      throw new Error(
        "The Global scope is always watched and cannot be unwatched (decision_01KRKS5H2A5QER84CJ8R4VD36Z).",
      );
    }
    const yaml = parseYaml(cur.rows[0].raw_yaml) as Record<string, unknown>;
    const wasWatched = yaml.watched === true;
    if (opts.watched === wasWatched) return;
    if (opts.watched) yaml.watched = true;
    else delete yaml.watched;
    await c.query(
      "UPDATE scopes SET raw_yaml = $1, updated_at = now() WHERE id = $2",
      [JSON.stringify(yaml), opts.targetScopeId],
    );
  });
}

/**
 * Read a scope's `watched` flag from its YAML. Returns false if the
 * scope is missing the flag or the file isn't readable.
 */
export async function readScopeWatchedInDoco(opts: {
  docoDir: string;
  targetScopeId: EntityId<"scope">;
}): Promise<boolean> {
  const { withClient } = await import("@doco/db");
  const r = await withClient((c) =>
    c.query<{ raw_yaml: string }>(
      "SELECT raw_yaml FROM scopes WHERE id = $1 LIMIT 1",
      [opts.targetScopeId],
    ),
  );
  if (!r.rows[0]) return false;
  try {
    const yaml = parseYaml(r.rows[0].raw_yaml) as Record<string, unknown>;
    return yaml.watched === true;
  } catch {
    return false;
  }
}

/**
 * Parse a textarea-style list of scope names (newline-separated). Names may
 * use slash-input as a convenience to express parent-child relationships:
 * `#country/#france/#payment` produces three scope entries with edges between
 * them. Per ADR-081, the slash never lands in a scope's `name` — each
 * segment is a distinct flat-named scope.
 *
 * Scope names are hashtag-shaped (`#country`, `#payment`). Bare segments
 * (`country`, `payment`) are accepted as a usability convenience — the
 * parser auto-prefixes `#`. Comment lines start with `#` followed by a
 * space (`# this is a comment`) and are skipped.
 *
 * Returns { valid, invalid }: each `valid` entry is a path of canonical
 * `#`-prefixed segments (root → leaf). Invalid lines are returned verbatim
 * so the caller can surface them.
 */
export function parseScopeNamesInput(
  input: string,
): { valid: string[][]; invalid: string[] } {
  const SEG_RE = /^#[a-z][a-z0-9_-]*$/;
  const seenPath = new Set<string>();
  const valid: string[][] = [];
  const invalid: string[] = [];
  for (const raw of input.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // Comment line: `#` followed by whitespace (or `#` alone). Scope-name
    // lines start with `#letter` (or a bare letter — we add the `#`).
    if (line === "#" || (line.startsWith("#") && /^#\s/.test(line))) continue;
    const segments = line
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.startsWith("#") ? s : `#${s}`));
    if (segments.length === 0 || !segments.every((s) => SEG_RE.test(s))) {
      invalid.push(line);
      continue;
    }
    const key = segments.join("/");
    if (seenPath.has(key)) continue;
    seenPath.add(key);
    valid.push(segments);
  }
  return { valid, invalid };
}

/**
 * Materialize a list of slash-paths into an edge-hierarchical scope tree.
 * Reuses existing scopes by name (case-sensitive); creates missing ones; sets
 * parent edges so `country/france/payment` becomes three scopes with the
 * parent edges pointing leaf → root.
 *
 * Existing scopes can be passed via `existingByName` to avoid double-creation.
 * If a leaf matches a registered ScopeTemplate the caller should pass it via
 * `templateForLeaf`; the leaf inherits the template's icon and gets seeded
 * with one Intent + N Rules via `seedScopeFromTemplate`.
 */
export async function materializeScopeTree(opts: {
  docoDir: string;
  docoId: EntityId<"doco">;
  paths: string[][];
  createdBy: EntityId<"principal"> | null;
  existingByName?: Map<string, EntityId<"scope">>;
  templateForLeaf?: (leafName: string) => ScopeTemplate | undefined;
}): Promise<{ created: EntityId<"scope">[]; byName: Map<string, EntityId<"scope">> }> {
  const byName = new Map(opts.existingByName ?? []);
  const created: EntityId<"scope">[] = [];
  for (const path of opts.paths) {
    let parentId: EntityId<"scope"> | null = null;
    for (let i = 0; i < path.length; i++) {
      const name = path[i]!;
      let id = byName.get(name);
      if (!id) {
        const isLeaf = i === path.length - 1;
        const tpl = isLeaf ? opts.templateForLeaf?.(name) : undefined;
        id = await createScopeInDoco({
          docoDir: opts.docoDir,
          docoId: opts.docoId,
          name,
          ...(tpl?.icon ? { icon: tpl.icon } : {}),
          ...(parentId ? { parentScopes: [parentId] } : {}),
          watched: false,
          createdBy: opts.createdBy,
        });
        byName.set(name, id);
        created.push(id);
        if (tpl) {
          await seedScopeFromTemplate({
            docoDir: opts.docoDir,
            docoId: opts.docoId,
            scopeId: id,
            template: tpl,
            createdBy: opts.createdBy,
          });
        }
      }
      parentId = id;
    }
  }
  return { created, byName };
}

/**
 * Migrate existing slash-named scopes into edge-hierarchical scopes (ADR-081).
 *
 * For each scope whose name contains `/`:
 *   1. Split the name into segments.
 *   2. Ensure a Scope entity exists for each segment (reuse by name; create if
 *      missing). The existing scope keeps its id but is renamed to the leaf
 *      segment.
 *   3. Set parent edges via the `scopes` field on each segment's scope.
 *
 * Returns the count of (created, renamed) — call sites can log them. Idempotent:
 * running again on already-migrated scopes is a no-op.
 */
export async function migrateScopesInDoco(opts: {
  docoDir: string;
  docoId: EntityId<"doco">;
  createdBy: EntityId<"principal"> | null;
}): Promise<{ created: number; renamed: number }> {
  const dir = join(opts.docoDir, "scopes");
  if (!existsSync(dir)) return { created: 0, renamed: 0 };

  // Read every existing scope.
  type ScopeFile = {
    file: string;
    yaml: Record<string, unknown>;
    id: EntityId<"scope">;
    name: string;
  };
  const all: ScopeFile[] = [];
  for (const f of await readdir(dir)) {
    if (!f.endsWith(".yaml")) continue;
    const text = await readFile(join(dir, f), "utf8");
    const yaml = parseYaml(text) as Record<string, unknown>;
    const id = String(yaml.id ?? "") as EntityId<"scope">;
    const name = String(yaml.name ?? "");
    if (!id || !name) continue;
    all.push({ file: f, yaml, id, name });
  }

  // Index by name. Slash-names index by their FULL string AND by their leaf
  // (so when we later split, we can find the existing entity by leaf).
  const byFullName = new Map<string, ScopeFile>();
  for (const s of all) byFullName.set(s.name, s);

  // Find slash-named scopes that need splitting.
  const slashed = all.filter((s) => s.name.includes("/"));
  if (slashed.length === 0) return { created: 0, renamed: 0 };

  // Build a map of segment-name → existing scope id (only if a flat scope
  // with that name already exists). This avoids double-creating roots.
  const flatByName = new Map<string, EntityId<"scope">>();
  for (const s of all) if (!s.name.includes("/")) flatByName.set(s.name, s.id);

  let created = 0;
  let renamed = 0;
  for (const s of slashed) {
    const segments = s.name.split("/").map((x) => x.trim()).filter(Boolean);
    if (segments.length < 2) continue;
    // Walk segments root → leaf, ensuring each exists.
    let parentId: EntityId<"scope"> | null = null;
    for (let i = 0; i < segments.length - 1; i++) {
      const segName = segments[i]!;
      let segId = flatByName.get(segName);
      if (!segId) {
        segId = await createScopeInDoco({
          docoDir: opts.docoDir,
          docoId: opts.docoId,
          name: segName,
          ...(parentId ? { parentScopes: [parentId] } : {}),
          watched: false,
          createdBy: opts.createdBy,
        });
        flatByName.set(segName, segId);
        created += 1;
      }
      parentId = segId;
    }
    // Rename the leaf scope (keep id stable) — update name to leaf segment
    // and set parent edge to the prior segment.
    const leafName = segments[segments.length - 1]!;
    s.yaml.name = leafName;
    const existingScopes = Array.isArray(s.yaml.scopes) ? (s.yaml.scopes as string[]) : [];
    s.yaml.scopes = parentId && !existingScopes.includes(parentId)
      ? [parentId, ...existingScopes]
      : existingScopes;
    // Refresh summary if it was the auto-generated "Scope: <slash-name>".
    if (typeof s.yaml.summary === "string" && s.yaml.summary === `Scope: ${s.name}`) {
      s.yaml.summary = `Scope: ${leafName}`;
    }
    await writeFile(join(dir, s.file), stringifyYaml(s.yaml), "utf8");
    flatByName.set(leafName, s.id);
    renamed += 1;
  }
  return { created, renamed };
}

/**
 * Apply a partial update to a Scope (ADR-084 — scope mgmt UX) by
 * UPDATEing the Postgres row + `raw_yaml`.
 *
 * Each field is independently optional. Pass:
 *   - `undefined` to leave it as-is
 *   - `null` or empty-string to clear the field (delete the YAML key)
 *   - a non-empty value to set it
 *
 * Caller is expected to reindex after. Throws if the scope doesn't exist.
 */
export interface UpdateScopeOptions {
  docoDir: string;
  scopeId: EntityId<"scope">;
  /** Single emoji icon. Pass `null` or "" to clear; omit to leave as-is. */
  icon?: string | null;
  /** The one Intent this scope serves. Pass null or [] to clear. */
  intentIds?: (EntityId<"intent"> | string)[] | null;
  /** Replace the entire parent list (not append). Pass [] to clear. */
  parentScopes?: EntityId<"scope">[];
  /**
   * Lifecycle transition. The Danger Zone "Abandon" button sends
   * "abandoned"; activation sends "active". Per the scope-abandonment
   * Decision.
   */
  lifecycle?: "active" | "abandoned" | "superseded";
  // Per decision_01KRPRDR1AD7S1RP6E69BQDB2G scope-rule management
  // moves to Rule entities — there is no scope-level authoring_rules
  // or guidance_rules field anymore. Use createRuleInDoco (insert) or
  // the rules PATCH endpoint (lifecycle / summary / body_md).
}

function applyScopeUpdate(yaml: Record<string, unknown>, opts: UpdateScopeOptions): void {
  delete yaml.primary_intent_id;
  if (opts.icon !== undefined) {
    if (opts.icon === null || opts.icon === "") delete yaml.icon;
    else yaml.icon = opts.icon;
  }
  if (opts.intentIds !== undefined) {
    const intentIds = opts.intentIds?.filter((id) => typeof id === "string" && id.length > 0) ?? [];
    if (intentIds.length === 0) delete yaml.intent_ids;
    else yaml.intent_ids = [intentIds[0]];
  }
  if (opts.parentScopes !== undefined) {
    yaml.scopes = opts.parentScopes;
  }
  if (opts.lifecycle !== undefined) {
    yaml.lifecycle = opts.lifecycle;
  }
}

export async function updateScopeInDoco(opts: UpdateScopeOptions): Promise<void> {
  const { withClient } = await import("@doco/db");
  await withClient(async (c) => {
    const cur = await c.query<{ raw_yaml: string }>(
      "SELECT raw_yaml FROM scopes WHERE id = $1 LIMIT 1",
      [opts.scopeId],
    );
    if (!cur.rows[0]) throw new Error(`Scope not found: ${opts.scopeId}`);
    const yaml = parseYaml(cur.rows[0].raw_yaml) as Record<string, unknown>;
    applyScopeUpdate(yaml, opts);
    await c.query(
      "UPDATE scopes SET raw_yaml = $1, lifecycle = COALESCE($2, lifecycle), updated_at = now() WHERE id = $3",
      [JSON.stringify(yaml), opts.lifecycle ?? null, opts.scopeId],
    );
  });
}

// `deleteScopeInDoco` was removed per the scope-abandonment Decision.
// Scopes follow the same six-state lifecycle as every other node — to
// abandon one, transition it to `abandoned` (no replacement) or
// `superseded` (a new scope took over). Existing members keep their tag;
// new captures are rejected. Use `updateScopeInDoco({ scopeId,
// lifecycle: "abandoned" })` (or "superseded") instead of deletion.

/**
 * Apply a partial update to a Doco's metadata (settings page) by
 * UPDATEing the Postgres row + `raw_yaml`.
 *
 *   - Each field undefined → leave it alone.
 *   - description / display_name: empty string clears the key.
 *   - visibility: only "private" or "public" accepted; other values rejected.
 *
 * Caller is expected to reindex.
 */
export interface UpdateDocoOptions {
  handle: string;
  description?: string | null;
  display_name?: string | null;
  visibility?: "private" | "public";
}

export async function updateDocoMeta(opts: UpdateDocoOptions): Promise<void> {
  if (opts.visibility !== undefined && opts.visibility !== "private" && opts.visibility !== "public") {
    throw new Error(`visibility must be "private" or "public", got: ${opts.visibility}`);
  }
  const { handle } = opts;
  const { withClient } = await import("@doco/db");
  await withClient(async (c) => {
    const cur = await c.query<{ raw_yaml: string }>(
      "SELECT raw_yaml FROM docos WHERE handle = $1 LIMIT 1",
      [handle],
    );
    if (!cur.rows[0]) throw new Error(`Doco "${handle}" not found.`);
    const yaml = parseYaml(cur.rows[0].raw_yaml) as Record<string, unknown>;
    if (opts.description !== undefined) {
      if (opts.description === null || opts.description === "") delete yaml.description;
      else yaml.description = opts.description;
    }
    if (opts.display_name !== undefined) {
      if (opts.display_name === null || opts.display_name === "") delete yaml.display_name;
      else yaml.display_name = opts.display_name;
    }
    if (opts.visibility !== undefined) yaml.visibility = opts.visibility;
    await c.query(
      `UPDATE docos
          SET name       = $2,
              visibility = COALESCE($3, visibility),
              raw_yaml   = $4,
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
  const handleError = validateRequestedDocoId(newHandle);
  if (handleError) throw new Error(handleError);
  if (oldHandle === newHandle) return;

  const { withClient } = await import("@doco/db");
  await withClient(async (c) => {
    const cur = await c.query<{ raw_yaml: string }>(
      "SELECT raw_yaml FROM docos WHERE handle = $1 LIMIT 1",
      [oldHandle],
    );
    if (!cur.rows[0]) throw new Error(`Doco "${oldHandle}" not found.`);
    const dup = await c.query(
      "SELECT 1 FROM docos WHERE handle = $1 LIMIT 1",
      [newHandle],
    );
    if (dup.rows[0]) throw new Error(`Doco "${newHandle}" already exists.`);
    const yaml = parseYaml(cur.rows[0].raw_yaml) as Record<string, unknown>;
    yaml.handle = newHandle;
    await c.query(
      `UPDATE docos
          SET handle     = $2,
              raw_yaml   = $3,
              updated_at = now()
        WHERE handle = $1`,
      [oldHandle, newHandle, JSON.stringify(yaml)],
    );
  });
}

/**
 * Delete a Doco. This is a hard delete — `ON DELETE CASCADE` removes
 * every entity, edge, and scope tied to the Doco.
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
  // Phase 3a: slug columns dropped. Derive owner_slug via JOIN to
  // identity tables and use the doco's handle as its slug stand-in.
  const r = await withClient((c) =>
    c.query<{ id: string; handle: string; owner_slug: string; owner_id: string }>(
      `SELECT d.id, d.handle, d.owner_id,
              COALESCE(p.username, o.slug, '') AS owner_slug
         FROM docos d
         LEFT JOIN principals p ON p.id = d.owner_id
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

/**
 * Bring a Doco's managed scopes into alignment with the current
 * DEFAULT_SCOPE_TEMPLATES (decision_01KRRD6QM7NN2EV56NZK96DNKY).
 *
 * Existing Docos that were created against earlier templates won't
 * automatically pick up new authoring rules added later. This helper
 * walks the registered templates, finds the matching scopes (by `name`)
 * on the target Doco, and:
 *
 *  1. **Seeds missing template rules.** For authoring rules, matches on
 *     a structural fingerprint of the predicate (kind + sorted params)
 *     so renamed prose doesn't double-seed. For guidance rules, matches
 *     on the exact summary text. Lifecycle="active".
 *
 *  2. **Abandons known-stale guidance rules.** A small allow-list of
 *     summaries from previous template versions get lifecycle-flipped
 *     to "abandoned" — narrow on purpose, so project-owner edits aren't
 *     touched.
 *
 *  3. **Seeds or refreshes the seed Intent.** Every managed template
 *     should have one Intent from `intentSummary`; missing seed Intents
 *     are created, and existing seed Intents are updated to the current
 *     intentSummary IF their current summary matches one of the known
 *     prior values.
 *
 * Idempotent: re-running is a no-op once every Doco is up to date.
 */
export async function applyScopeTemplateUpdatesToDoco(opts: {
  docoDir?: string;
  docoId: EntityId<"doco">;
  createdBy: EntityId<"principal"> | null;
}): Promise<{
  scopesTouched: number;
  rulesAdded: number;
  rulesAbandoned: number;
  intentsAdded: number;
  intentsUpdated: number;
}> {
  const { withClient } = await import("@doco/db");
  let scopesTouched = 0;
  let rulesAdded = 0;
  let rulesAbandoned = 0;
  let intentsAdded = 0;
  let intentsUpdated = 0;

  // ── Known-stale summaries to phase out ──────────────────────────────
  // Narrow on purpose: only the verbatim seeds shipped by prior template
  // versions. Owner-edited rules diverge by even one character and are
  // left alone.
  const STALE_USER_FLOWS_GUIDANCE_SUMMARIES = new Set<string>([
    'Each flow gets one Intent representing the journey. Examples: "user buys a product", "agent claims a Doco".',
    "Each step in the flow is an Action chained with the `follows` field so the order is explicit and the cycle-lint guards against loops.",
    'Each branch in the flow is a Decision referenced from the Action that depends on it via `decision_ids`. Example: "if cart total > $X, require 2FA".',
    "Use Reasoning entities to justify non-obvious orderings or merges in the flow.",
    "Don't capture state diagrams in user-flows — Doco is process-centric, not state-machine-centric.",
    "User-flows holds DESIGNED steps (Actions: verb in imperative/present, role-typed actor, designed inputs/outputs). Specific recorded events — a real commit that pushed, a deploy that ran, a verification that passed — are Logs and belong in a separate project-owner-authored scope, not here.",
  ]);
  const STALE_USER_FLOWS_INTENT_SUMMARIES = new Set<string>([
    "End-to-end user journeys are documented step-by-step so any feature can be traced from start to finish. Capture the journey as an Intent, each step as an Action linked to that Intent (`follows` between Actions encodes order), and each branch as a Decision with populated alternatives. This scope is process-centric — don't model state machines here. User-flows holds DESIGNED steps (Action: imperative verb, role-typed actor, designed inputs/outputs); recorded happenings (real commits, deploys, verifications) are Logs and belong in a separate project-owner-authored scope.",
    "End-to-end user journeys are documented step-by-step so any feature can be traced from start to finish.",
    "End-to-end user journeys: how a person (or external system) moves through a feature from start to finish.",
  ]);
  const STALE_GLOBAL_INTENT_SUMMARIES = new Set<string>([
    "The load-bearing claims that govern this Doco — invariants, authority, and the rules that other rules cite.",
  ]);

  // Structural fingerprint for an authoring predicate. Used to dedupe
  // template-seeded rules against existing ones without depending on
  // human-readable summary text.
  const fingerprint = (p: AuthoringPredicate): string => {
    const sorted = Object.keys(p as object)
      .sort()
      .map((k) => `${k}=${JSON.stringify((p as Record<string, unknown>)[k])}`)
      .join("|");
    return sorted;
  };

  for (const template of DEFAULT_SCOPE_TEMPLATES) {
    // 1. Find the scope (by name) on this Doco.
    const scopeRow = await withClient((c) =>
      c.query<{ id: string }>(
        "SELECT id FROM scopes WHERE doco_id = $1 AND name = $2 LIMIT 1",
        [opts.docoId, template.name],
      ),
    );
    if (scopeRow.rows.length === 0) continue;
    const scopeId = scopeRow.rows[0]!.id as EntityId<"scope">;
    scopesTouched += 1;

    const isStaleUserFlowsAuthoringPredicate = (p: AuthoringPredicate): boolean =>
      p.kind === "requires_node_type" &&
      Array.isArray(p.node_types) &&
      p.node_types.length === 4 &&
      ["intent", "action", "decision", "reference"].every((t) =>
        (p.node_types as string[]).includes(t),
      );

    // 2. Load this scope's existing rules (active + proposed only — we
    // don't want to count abandoned/superseded entries against the new
    // template).
    const existing = await withClient((c) =>
      c.query<{
        id: string;
        summary: string;
        lifecycle: string;
        raw_yaml: string;
      }>(
        `SELECT r.id, r.summary, COALESCE(r.lifecycle, 'active') AS lifecycle, r.raw_yaml
           FROM rules r
           JOIN edges e ON e.from_id = r.id
                       AND e.edge_type = 'in_scope_of'
                       AND e.to_id = $1
          WHERE r.doco_id = $2
            AND COALESCE(r.lifecycle, 'active') IN ('active', 'proposed')`,
        [scopeId, opts.docoId],
      ),
    );

    const existingAuthoringFingerprints = new Set<string>();
    const existingGuidanceSummaries = new Set<string>();
    type RuleRow = (typeof existing.rows)[number];
    const staleRuleRows: RuleRow[] = [];
    for (const row of existing.rows) {
      let fm: Record<string, unknown> = {};
      try {
        fm = JSON.parse(row.raw_yaml) as Record<string, unknown>;
      } catch {
        // Ignore parse errors — rule still counts as present by summary.
      }
      // v7: kind is "guidance" | "tagged" (or unset → defaults to
      // "tagged" when a predicate is set, "guidance" otherwise). An
      // authoring rule is one with a predicate.
      const predicate = fm.predicate as AuthoringPredicate | undefined;
      if (predicate) {
        if (
          template.name === "#user-flows" &&
          isStaleUserFlowsAuthoringPredicate(predicate)
        ) {
          staleRuleRows.push(row);
        }
        existingAuthoringFingerprints.add(fingerprint(predicate));
      } else {
        existingGuidanceSummaries.add(row.summary.trim());
      }
      if (
        template.name === "#user-flows" &&
        STALE_USER_FLOWS_GUIDANCE_SUMMARIES.has(row.summary.trim())
      ) {
        staleRuleRows.push(row);
      }
    }

    // 3. Seed missing template rules.
    for (const tplRule of template.rules) {
      const summary = tplRule.summary.trim();
      if (!summary) continue;
      if (tplRule.predicate) {
        if (existingAuthoringFingerprints.has(fingerprint(tplRule.predicate))) continue;
        await createRuleInDoco({
          docoId: opts.docoId,
          ...(tplRule.kind ? { kind: tplRule.kind } : {}),
          summary,
          predicate: tplRule.predicate,
          ...(tplRule.fires_when_node_lifecycle
            ? { fires_when_node_lifecycle: tplRule.fires_when_node_lifecycle }
            : {}),
          ...(tplRule.body_md ? { body_md: tplRule.body_md } : {}),
          scopeId,
          createdBy: opts.createdBy,
        });
        rulesAdded += 1;
      } else {
        if (existingGuidanceSummaries.has(summary)) continue;
        await createRuleInDoco({
          docoId: opts.docoId,
          kind: tplRule.kind ?? "guidance",
          summary,
          ...(tplRule.body_md ? { body_md: tplRule.body_md } : {}),
          scopeId,
          createdBy: opts.createdBy,
        });
        rulesAdded += 1;
      }
    }

    // 4. Lifecycle-flip stale rows. (user-flows only for now — Global
    // keeps its current guidance set intact.)
    for (const row of staleRuleRows) {
      await withClient(async (c) => {
        let fm: Record<string, unknown> = {};
        try {
          fm = JSON.parse(row.raw_yaml) as Record<string, unknown>;
        } catch {
          fm = {};
        }
        fm.lifecycle = "abandoned";
        const now = nowIso();
        fm.updated_at = now;
        if (opts.createdBy) fm.updated_by = opts.createdBy;
        await c.query(
          `UPDATE rules
              SET lifecycle = 'abandoned',
                  raw_yaml = $1,
                  updated_at = $2,
                  updated_by = $3
            WHERE id = $4`,
          [JSON.stringify(fm), now, opts.createdBy, row.id],
        );
      });
      rulesAbandoned += 1;
    }

    // 5. Ensure the template has a seed Intent, then refresh known stale
    // summaries to the current template copy.
    if (template.intentSummary.trim()) {
      const intentRows = await withClient((c) =>
        c.query<{ id: string; summary: string; raw_yaml: string }>(
          `SELECT i.id, i.summary, i.raw_yaml
             FROM intents i
             JOIN edges e ON e.from_id = i.id
                         AND e.edge_type = 'in_scope_of'
                         AND e.to_id = $1
            WHERE i.doco_id = $2
              AND COALESCE(i.lifecycle, 'active') IN ('active', 'proposed')`,
          [scopeId, opts.docoId],
        ),
      );
      if (intentRows.rows.length === 0) {
        const intentId = await createIntentInDoco({
          docoId: opts.docoId,
          summary: template.intentSummary.trim(),
          scopeId,
          createdBy: opts.createdBy,
        });
        await updateScopeInDoco({
          docoDir: opts.docoDir ?? "",
          scopeId,
          intentIds: [intentId],
        });
        intentsAdded += 1;
        continue;
      }
      for (const ir of intentRows.rows) {
        if (template.name === "#user-flows") {
          if (!STALE_USER_FLOWS_INTENT_SUMMARIES.has(ir.summary.trim())) continue;
        } else if (template.name === "#global") {
          if (!STALE_GLOBAL_INTENT_SUMMARIES.has(ir.summary.trim())) continue;
        } else {
          continue;
        }
        await withClient(async (c) => {
          let fm: Record<string, unknown> = {};
          try {
            fm = JSON.parse(ir.raw_yaml) as Record<string, unknown>;
          } catch {
            fm = {};
          }
          fm.summary = template.intentSummary;
          const now = nowIso();
          fm.updated_at = now;
          if (opts.createdBy) fm.updated_by = opts.createdBy;
          await c.query(
            `UPDATE intents
                SET summary = $1,
                    raw_yaml = $2,
                    updated_at = $3,
                    updated_by = $4
              WHERE id = $5`,
            [template.intentSummary, JSON.stringify(fm), now, opts.createdBy, ir.id],
          );
        });
        intentsUpdated += 1;
      }
    }
  }

  return { scopesTouched, rulesAdded, rulesAbandoned, intentsAdded, intentsUpdated };
}
