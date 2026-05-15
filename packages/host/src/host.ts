import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type EntityId,
  type Organization,
  type Principal,
  generateUlid,
  makeEntityId,
  nowIso,
  HOST_RESERVED_SLUGS,
  validateDocoSlug,
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
import { findScopeTemplate } from "./scope-templates.js";

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

export async function listPrincipals(root: string): Promise<OwnerSummary[]> {
  if (process.env.DOCO_STORAGE === "postgres") {
    const { withClient } = await import("@doco/db");
    const r = await withClient((c) =>
      c.query<{ id: string; username: string; display_name: string | null }>(
        "SELECT id, username, display_name FROM principals WHERE deactivated_at IS NULL ORDER BY username",
      ),
    );
    return r.rows.map((row) => ({
      kind: "principal" as const,
      id: row.id as EntityId<"principal">,
      slug: row.username,
      display_name: row.display_name ?? row.username,
    }));
  }
  return listEntitiesAs(hostPrincipalsDir(root), "principal", (e) => ({
    kind: "principal",
    id: e.id as EntityId<"principal">,
    slug: e.username as string,
    display_name: (e.display_name as string) ?? (e.username as string),
  }));
}

export async function listOrganizations(root: string): Promise<OwnerSummary[]> {
  if (process.env.DOCO_STORAGE === "postgres") {
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
  return listEntitiesAs(hostOrganizationsDir(root), "organization", (e) => ({
    kind: "organization",
    id: e.id as EntityId<"organization">,
    slug: e.slug as string,
    display_name: (e.display_name as string) ?? (e.slug as string),
  }));
}

async function listEntitiesAs<T>(
  dir: string,
  prefix: string,
  toSummary: (e: Record<string, unknown>) => T,
): Promise<T[]> {
  if (!existsSync(dir)) return [];
  const out: T[] = [];
  for (const name of await readdir(dir)) {
    if (!name.startsWith(`${prefix}_`)) continue;
    if (!name.endsWith(".yaml")) continue;
    const text = await readFile(join(dir, name), "utf8");
    const data = parseYaml(text) as Record<string, unknown>;
    out.push(toSummary(data));
  }
  return out;
}

export async function resolveOwnerSlug(root: string, slug: string): Promise<OwnerSummary | null> {
  const [users, orgs] = await Promise.all([listPrincipals(root), listOrganizations(root)]);
  return users.find((p) => p.slug === slug) ?? orgs.find((o) => o.slug === slug) ?? null;
}

/**
 * Slugs that name top-level @doco/web routes — rejected by addPrincipal /
 * addOrganization / createDocoInHost so a User or Org can never collide
 * with the URL routing layer (ADR-067). Re-exported for back-compat;
 * canonical source is `HOST_RESERVED_SLUGS` in @doco/shared.
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

async function assertSlugFree(root: string, slug: string, kind: "principal" | "organization"): Promise<void> {
  assertSlugAllowed(slug, kind);
  const existing = await resolveOwnerSlug(root, slug);
  if (existing) {
    throw new Error(
      `Slug "${slug}" is already taken by a ${existing.kind} in this host (${existing.id}). ` +
        `Within a host, Principal.username and Organization.slug share one namespace (ADR-064).`,
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────────────────────────────────

export interface AddPrincipalOptions {
  username: string;
  email?: string;
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
  root: string,
  githubLogin: string,
): Promise<{ id: EntityId<"principal">; username: string } | null> {
  if (process.env.DOCO_STORAGE === "postgres") {
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
  if (detectMode(root) !== "host") return null;
  const { existsSync, readFileSync, readdirSync } = await import("node:fs");
  const dir = hostPrincipalsDir(root);
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("principal_") || !name.endsWith(".yaml")) continue;
    const text = readFileSync(join(dir, name), "utf8");
    const e = parseYaml(text) as Record<string, unknown>;
    const gh = e.github_identity as { github_login?: string } | undefined;
    if (gh?.github_login && gh.github_login.toLowerCase() === githubLogin.toLowerCase()) {
      return {
        id: e.id as EntityId<"principal">,
        username: e.username as string,
      };
    }
  }
  return null;
}

export async function addPrincipal(
  root: string,
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
    display_name: opts.display_name ?? opts.username,
    github_identity: gh,
    created_at: created,
    created_by: id,
    lifecycle: "active",
    scopes: [],
  };

  if (process.env.DOCO_STORAGE === "postgres") {
    const { withClient } = await import("@doco/db");
    // Username-unique check at the DB level (UNIQUE constraint on principals.username
    // will surface a 23505 error if the slug is taken; surface a cleaner error here).
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
          opts.display_name ?? opts.username,
          opts.email ?? null,
          gh.github_login ?? null,
          null,
          null,
          stringifyYaml(yaml),
          created,
        ],
      );
    });
    return id;
  }

  if (detectMode(root) !== "host") throw new Error("Not a Host directory");
  await assertSlugFree(root, opts.username, "principal");
  await writeFile(join(hostPrincipalsDir(root), `${id}.yaml`), stringifyYaml(yaml), "utf8");
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

  if (process.env.DOCO_STORAGE === "postgres") {
    const { withClient } = await import("@doco/db");
    await withClient(async (c) => {
      const dup = await c.query("SELECT 1 FROM organizations WHERE slug = $1 LIMIT 1", [opts.slug]);
      if (dup.rows.length > 0) throw new Error(`Slug "${opts.slug}" is already taken.`);
      await c.query(
        `INSERT INTO organizations (id, slug, name, raw_yaml, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)`,
        [id, opts.slug, opts.display_name ?? opts.slug, stringifyYaml(yaml), created],
      );
      // Owner is automatically a member with `owner` role.
      await c.query(
        `INSERT INTO org_members (org_id, principal_id, role, joined_at)
         VALUES ($1, $2, 'owner', $3)`,
        [id, owner.id, created],
      );
    });
    return id;
  }

  if (detectMode(root) !== "host") throw new Error("Not a Host directory");
  await assertSlugFree(root, opts.slug, "organization");
  await writeFile(
    join(hostOrganizationsDir(root), `${id}.yaml`),
    stringifyYaml(yaml),
    "utf8",
  );
  return id;
}

// ──────────────────────────────────────────────────────────────────────────
// docos in a host
// ──────────────────────────────────────────────────────────────────────────

export interface CreateDocoInHostOptions {
  ownerSlug: string; // resolves to user or org
  docoSlug: string;
  description?: string;
  visibility?: "private" | "public";
  /**
   * If true and `docoSlug` is already taken, silently try `<slug>-2`,
   * `<slug>-3`, … until a free slot is found and create there. The
   * actually-used slug comes back on the returned record. Caller MUST
   * read `record.docoSlug` (don't reuse `opts.docoSlug`) when building
   * URLs.
   *
   * Use this when the caller may not have visibility into the existing
   * Doco — e.g. the anonymous agent-onboarding flow. Surfacing
   * "<slug> already exists" in that context would leak the existence
   * of a private Doco to an unauthorized caller (intent
   * `private-docos-actually-private`). In owner-authorized flows
   * (`new-doco`, `claim/<token>`) keep this `false` and surface the
   * collision explicitly — the caller can see the collider and needs
   * to choose.
   */
  autoSuffixOnCollision?: boolean;
}

export interface DocoRecord {
  ownerSlug: string;
  docoSlug: string;
  ownerKind: "principal" | "organization";
  ownerId: EntityId<"principal"> | EntityId<"organization">;
  docoId: EntityId<"doco">;
  path: string;
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

  if (process.env.DOCO_STORAGE === "postgres") {
    const { withClient } = await import("@doco/db");
    let docoSlug = opts.docoSlug;
    // Auto-suffix-on-collision: SELECT against docos table.
    if (opts.autoSuffixOnCollision) {
      let n = 2;
      while (true) {
        const dup = await withClient((c) =>
          c.query(
            "SELECT 1 FROM docos WHERE owner_slug = $1 AND doco_slug = $2 LIMIT 1",
            [opts.ownerSlug, docoSlug],
          ),
        );
        if (dup.rows.length === 0) break;
        docoSlug = `${opts.docoSlug}-${n}`;
        n++;
        if (n > 999) {
          throw new Error(
            `Auto-suffix exhausted: ${opts.ownerSlug}/${opts.docoSlug}-2 … -999 are all taken.`,
          );
        }
      }
    } else {
      const dup = await withClient((c) =>
        c.query(
          "SELECT 1 FROM docos WHERE owner_slug = $1 AND doco_slug = $2 LIMIT 1",
          [opts.ownerSlug, docoSlug],
        ),
      );
      if (dup.rows.length > 0) {
        throw new Error(`Doco "${opts.ownerSlug}/${docoSlug}" already exists.`);
      }
    }

    const docoId = makeEntityId("doco", generateUlid()) as EntityId<"doco">;
    const created = nowIso();
    const docoYaml = {
      id: docoId,
      node_type: "doco",
      slug: docoSlug,
      display_name: docoSlug,
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
        `INSERT INTO docos (id, owner_slug, doco_slug, owner_id, name, visibility, raw_yaml, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [docoId, opts.ownerSlug, docoSlug, owner.id, docoSlug, opts.visibility ?? "private", stringifyYaml(docoYaml), created],
      ),
    );

    // Seed Constitution scope — createScopeInDoco has its own postgres branch.
    const constitutionTemplate = findScopeTemplate("constitution");
    await createScopeInDoco({
      docoDir: hostDocoDir(root, opts.ownerSlug, docoSlug), // unused in PG mode but type requires it
      docoId,
      name: "constitution",
      ...(constitutionTemplate?.icon ? { icon: constitutionTemplate.icon } : {}),
      ...(constitutionTemplate?.purpose ? { purpose: constitutionTemplate.purpose } : {}),
      ...(constitutionTemplate?.guidelines ? { guidelines: constitutionTemplate.guidelines } : {}),
      rules: [
        {
          kind: "probabilistic",
          spec: "Behavioral reminder, not a per-node check — agents are expected to surface the Doco's scope manifest to the project owner at session start and whenever the conversation moves into new territory, and to flag drift in the watched set.",
          reason:
            "Agents must proactively surface this Doco's scope manifest to the project owner — naming each scope, its purpose, and which carry the `watched` flag — and remind them that watched scopes only stay load-bearing when the project owner reviews them as the project evolves, retiring stale ones, sharpening vague ones, and adding new ones whose absence would let real work slip out of view.",
        },
      ],
      watched: true,
      createdBy: owner.kind === "principal" ? owner.id : null,
    });

    return {
      ownerSlug: opts.ownerSlug,
      docoSlug,
      ownerKind: owner.kind,
      ownerId: owner.id,
      docoId,
      path: hostDocoDir(root, opts.ownerSlug, docoSlug),
    };
  }

  if (detectMode(root) !== "host") throw new Error("Not a Host directory");

  // Resolve the actual slug to use, applying auto-suffix if requested
  // and the desired slot is taken. `<slug>-2`, `<slug>-3`, … — cap at
  // 999 so a permission-failure-as-collision can't loop forever.
  let docoSlug = opts.docoSlug;
  if (opts.autoSuffixOnCollision) {
    let n = 2;
    while (existsSync(join(hostDocoDir(root, opts.ownerSlug, docoSlug), "doco.yaml"))) {
      docoSlug = `${opts.docoSlug}-${n}`;
      n++;
      if (n > 999) {
        throw new Error(
          `Auto-suffix exhausted: ${opts.ownerSlug}/${opts.docoSlug}-2 … -999 are all taken.`,
        );
      }
    }
  }
  const dir = hostDocoDir(root, opts.ownerSlug, docoSlug);

  // "Already exists" means the slug is genuinely taken — there's a doco.yaml.
  // A bare directory with no doco.yaml is a half-created leftover from a
  // failed previous attempt; we'll clean it up and proceed (per
  // Phase-21 atomicity fix).
  if (existsSync(join(dir, "doco.yaml"))) {
    throw new Error(`Doco already exists at ${dir}.`);
  }
  if (existsSync(dir)) {
    // Half-created — wipe and start over.
    await rm(dir, { recursive: true, force: true });
  }

  // Wrap the directory build so a partial failure rolls the whole thing back.
  // Without this, a thrown writeFile leaves the dir + subdirs on disk and
  // blocks retries with a misleading "already exists" error.
  try {
    await mkdir(dir, { recursive: true });
    for (const sub of [
      "principals",
      "intents",
      "ideas",
      "rules",
      "decisions",
      "actions",
      "reasoning",
      "references",
      "scopes",
      "organizations",
      "evals",
    ]) {
      await mkdir(join(dir, sub), { recursive: true });
    }

    const docoId = makeEntityId("doco", generateUlid()) as EntityId<"doco">;
    const created = nowIso();
    const docoYaml = {
      id: docoId,
      node_type: "doco",
      // Bare slug only — the owner segment is implied by the parent directory.
      // (`<owner>/<doco>` is reconstructible; storing the compound here led to
      // /<owner>/<owner>/<doco> URLs. Per `fix-owner-prefix-duplicated-in-doco-slug`.)
      slug: docoSlug,
      display_name: docoSlug,
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
    await writeFile(join(dir, "doco.yaml"), stringifyYaml(docoYaml), "utf8");
    await writeFile(
      join(dir, "README.md"),
      `# ${docoSlug}\n\nOwner: ${owner.kind} \`${opts.ownerSlug}\`.\n`,
      "utf8",
    );
    await writeFile(
      join(dir, ".gitignore"),
      "# Local cache — regenerable\n.doco/\n",
      "utf8",
    );

    // Seed the Constitution scope — every Doco has one per the
    // `constitution-scope-default-and-tab` ADR. The scope ships pre-loaded
    // with one framework-seeded rule: a probabilistic
    // scope-manifest-visibility rule that obliges agents to keep the
    // project owner current on the manifest (watched scopes especially).
    // It is seeded at creation and therefore non-editable from the UI —
    // owner-authored rules can be added alongside it later via /scopes.
    //
    // `watched: true` — fifth framework-native behavior of the
    // Constitution (decision_01KRKS5H2A5QER84CJ8R4VD36Z): it is always
    // watched and cannot be unwatched. Write paths reject watched: false;
    // readers project is_watched=true regardless of stored state.
    const constitutionTemplate = findScopeTemplate("constitution");
    await createScopeInDoco({
      docoDir: dir,
      docoId,
      name: "constitution",
      ...(constitutionTemplate?.icon ? { icon: constitutionTemplate.icon } : {}),
      ...(constitutionTemplate?.purpose ? { purpose: constitutionTemplate.purpose } : {}),
      ...(constitutionTemplate?.guidelines ? { guidelines: constitutionTemplate.guidelines } : {}),
      rules: [
        {
          kind: "probabilistic",
          spec: "Behavioral reminder, not a per-node check — agents are expected to surface the Doco's scope manifest to the project owner at session start and whenever the conversation moves into new territory, and to flag drift in the watched set.",
          reason:
            "Agents must proactively surface this Doco's scope manifest to the project owner — naming each scope, its purpose, and which carry the `watched` flag — and remind them that watched scopes only stay load-bearing when the project owner reviews them as the project evolves, retiring stale ones, sharpening vague ones, and adding new ones whose absence would let real work slip out of view.",
        },
      ],
      watched: true,
      createdBy: owner.kind === "principal" ? owner.id : null,
    });

    return {
      ownerSlug: opts.ownerSlug,
      docoSlug,
      ownerKind: owner.kind,
      ownerId: owner.id,
      docoId,
      path: dir,
    };
  } catch (err) {
    // Rollback: rm the partial dir so the retry isn't blocked.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Write a Scope entity into a Doco's `scopes/` directory. Per ADR-080
 * (creation flow) + ADR-081 (edge hierarchy) + ADR-082 (purpose + guidelines).
 *
 * Names are flat tokens; parent scopes go in the `scopes` array. To express
 * `country/france/payment`, create three scopes — `country`, `france` (with
 * `scopes: [country.id]`), `payment` (with `scopes: [france.id]`).
 *
 * Use `parseScopeNamesInput` + `materializeScopeTree` for friendly slash-input
 * → edge-tree conversion.
 */
export interface CreateScopeOptions {
  docoDir: string;
  docoId: EntityId<"doco">;
  name: string;
  /** Single emoji used to identify this scope at a glance. Optional. */
  icon?: string;
  description?: string;
  /** Why this scope exists (ADR-082). */
  purpose?: string;
  /** Markdown guidance on how to author nodes in this scope (ADR-082). */
  guidelines?: string;
  /** Parent scopes — semantically "this scope belongs to those." (ADR-081) */
  parentScopes?: EntityId<"scope">[];
  /**
   * Optional rules — predicates the engine evaluates when a node enters
   * this scope (on capture / scope-add via update).
   */
  rules?: unknown[];
  /**
   * Whether this scope is "watched" — a soft attention signal for
   * contributors (person or agent). When authoring a node, scan against
   * watched scopes and tag the new node into any that fit. Stored as
   * `watched: true` on the scope's own YAML. NOT enforced at capture
   * time — hard enforcement is what `mandatory_scope` Constitution rules
   * are for (a separate mechanism, accessed via the scope's Rules
   * editor, not the watched toggle). Required on every scope creation
   * — no default — so the choice is always explicit.
   */
  watched: boolean;
  createdBy: EntityId<"principal"> | null;
}

export async function createScopeInDoco(
  opts: CreateScopeOptions,
): Promise<EntityId<"scope">> {
  const id = makeEntityId("scope", generateUlid()) as EntityId<"scope">;
  const created = nowIso();
  // Fifth framework-native behavior of the Constitution scope
  // (decision_01KRKS5H2A5QER84CJ8R4VD36Z, rule_01KRKS60A11YEWDASBT6V3HTE9):
  // it is always watched and cannot be unwatched. Force watched=true
  // for any scope named "constitution" regardless of the caller's input.
  const watched = opts.name === "constitution" ? true : opts.watched;
  const yaml: Record<string, unknown> = {
    id,
    doco_id: opts.docoId,
    node_type: "scope",
    summary: opts.description?.trim() || opts.purpose?.trim() || `Scope: ${opts.name}`,
    name: opts.name,
    ...(opts.icon ? { icon: opts.icon } : {}),
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.purpose ? { purpose: opts.purpose } : {}),
    ...(opts.guidelines ? { guidelines: opts.guidelines } : {}),
    created_at: created,
    created_by: opts.createdBy,
    lifecycle: "active",
    scopes: opts.parentScopes ?? [],
    ...(opts.rules && opts.rules.length > 0 ? { rules: opts.rules } : {}),
    ...(watched ? { watched: true } : {}),
  };
  if (process.env.DOCO_STORAGE === "postgres") {
    const { withClient } = await import("@doco/db");
    await withClient((c) =>
      c.query(
        `INSERT INTO scopes (id, doco_id, name, summary, lifecycle, raw_yaml, created_at, updated_at, created_by, updated_by)
         VALUES ($1, $2, $3, $4, 'active', $5, $6, $6, $7, $7)`,
        [id, opts.docoId, opts.name, yaml.summary as string, stringifyYaml(yaml), created, opts.createdBy],
      ),
    );
    return id;
  }
  const dir = join(opts.docoDir, "scopes");
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.yaml`), stringifyYaml(yaml), "utf8");
  return id;
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
  if (process.env.DOCO_STORAGE === "postgres") {
    const { withClient } = await import("@doco/db");
    await withClient(async (c) => {
      const cur = await c.query<{ raw_yaml: string; name: string }>(
        "SELECT raw_yaml, name FROM scopes WHERE id = $1 LIMIT 1",
        [opts.targetScopeId],
      );
      if (!cur.rows[0]) throw new Error(`Scope not found: ${opts.targetScopeId}`);
      if (cur.rows[0].name === "constitution" && opts.watched === false) {
        throw new Error(
          "The Constitution scope is always watched and cannot be unwatched (decision_01KRKS5H2A5QER84CJ8R4VD36Z).",
        );
      }
      const yaml = parseYaml(cur.rows[0].raw_yaml) as Record<string, unknown>;
      const wasWatched = yaml.watched === true;
      if (opts.watched === wasWatched) return;
      if (opts.watched) yaml.watched = true;
      else delete yaml.watched;
      await c.query(
        "UPDATE scopes SET raw_yaml = $1, updated_at = now() WHERE id = $2",
        [stringifyYaml(yaml), opts.targetScopeId],
      );
    });
    return;
  }
  const file = join(opts.docoDir, "scopes", `${opts.targetScopeId}.yaml`);
  if (!existsSync(file)) throw new Error(`Scope not found: ${opts.targetScopeId}`);
  const yaml = parseYaml(await readFile(file, "utf8")) as Record<string, unknown>;
  // Fifth framework-native behavior of the Constitution scope
  // (decision_01KRKS5H2A5QER84CJ8R4VD36Z, rule_01KRKS60A11YEWDASBT6V3HTE9):
  // it is always watched and cannot be unwatched.
  if (yaml.name === "constitution" && opts.watched === false) {
    throw new Error(
      "The Constitution scope is always watched and cannot be unwatched (decision_01KRKS5H2A5QER84CJ8R4VD36Z).",
    );
  }
  const wasWatched = yaml.watched === true;
  if (opts.watched === wasWatched) return;
  if (opts.watched) {
    yaml.watched = true;
  } else {
    delete yaml.watched;
  }
  await writeFile(file, stringifyYaml(yaml), "utf8");
}

/**
 * Read a scope's `watched` flag from its YAML. Returns false if the
 * scope is missing the flag or the file isn't readable.
 */
export async function readScopeWatchedInDoco(opts: {
  docoDir: string;
  targetScopeId: EntityId<"scope">;
}): Promise<boolean> {
  if (process.env.DOCO_STORAGE === "postgres") {
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
  const file = join(opts.docoDir, "scopes", `${opts.targetScopeId}.yaml`);
  if (!existsSync(file)) return false;
  try {
    const yaml = parseYaml(await readFile(file, "utf8")) as Record<string, unknown>;
    return yaml.watched === true;
  } catch {
    return false;
  }
}

/**
 * Parse a textarea-style list of scope names (newline-separated). Names may
 * use slash-input as a convenience to express parent-child relationships:
 * `country/france/payment` produces three scope entries with edges between
 * them. Per ADR-081, the slash never lands in a scope's `name` — each
 * segment is a distinct flat-named scope.
 *
 * Returns { valid, invalid }: each `valid` entry is a path of segments
 * (root → leaf). Invalid lines are returned verbatim so the caller can
 * surface them.
 */
export function parseScopeNamesInput(
  input: string,
): { valid: string[][]; invalid: string[] } {
  const SEG_RE = /^[a-z][a-z0-9_-]*$/;
  const seenPath = new Set<string>();
  const valid: string[][] = [];
  const invalid: string[] = [];
  for (const raw of input.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const segments = line.split("/").map((s) => s.trim()).filter(Boolean);
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
 * If a template prefills purpose/guidelines for a path's leaf, the caller
 * should look it up via `findScopeTemplate` and pass it as `templateForLeaf`.
 *
 * Per ADR-081 + ADR-082.
 */
export async function materializeScopeTree(opts: {
  docoDir: string;
  docoId: EntityId<"doco">;
  paths: string[][];
  createdBy: EntityId<"principal"> | null;
  existingByName?: Map<string, EntityId<"scope">>;
  templateForLeaf?: (
    leafName: string,
  ) => { icon?: string; purpose?: string; guidelines?: string } | undefined;
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
          ...(tpl?.purpose ? { purpose: tpl.purpose } : {}),
          ...(tpl?.guidelines ? { guidelines: tpl.guidelines } : {}),
          ...(parentId ? { parentScopes: [parentId] } : {}),
          watched: false,
          createdBy: opts.createdBy,
        });
        byName.set(name, id);
        created.push(id);
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
 * Apply a partial update to a Scope (ADR-084 — scope mgmt UX). In
 * Postgres mode this UPDATEs the row + `raw_yaml`; the legacy CLI
 * filesystem mode rewrites the on-disk YAML in place.
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
  purpose?: string | null;
  guidelines?: string | null;
  /** Replace the entire parent list (not append). Pass [] to clear. */
  parentScopes?: EntityId<"scope">[];
  /**
   * Replace the entire rules list. Pass null to clear.
   */
  rules?: unknown[] | null;
  /**
   * Lifecycle transition. The Danger Zone "Deprecate" button sends
   * "abandoned"; reactivation sends "active". Per the
   * `scopes-are-deprecated-not-deleted` Decision.
   */
  lifecycle?: "active" | "abandoned" | "superseded";
}

function applyScopeUpdate(yaml: Record<string, unknown>, opts: UpdateScopeOptions): void {
  if (opts.icon !== undefined) {
    if (opts.icon === null || opts.icon === "") delete yaml.icon;
    else yaml.icon = opts.icon;
  }
  if (opts.purpose !== undefined) {
    if (opts.purpose === null || opts.purpose === "") delete yaml.purpose;
    else yaml.purpose = opts.purpose;
  }
  if (opts.guidelines !== undefined) {
    if (opts.guidelines === null || opts.guidelines === "") delete yaml.guidelines;
    else yaml.guidelines = opts.guidelines;
  }
  if (opts.parentScopes !== undefined) {
    yaml.scopes = opts.parentScopes;
  }
  if (opts.rules !== undefined) {
    if (opts.rules === null || opts.rules.length === 0) delete yaml.rules;
    else yaml.rules = opts.rules;
  }
  if (opts.lifecycle !== undefined) {
    yaml.lifecycle = opts.lifecycle;
  }
}

export async function updateScopeInDoco(opts: UpdateScopeOptions): Promise<void> {
  if (process.env.DOCO_STORAGE === "postgres") {
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
        [stringifyYaml(yaml), opts.lifecycle ?? null, opts.scopeId],
      );
    });
    return;
  }
  const file = join(opts.docoDir, "scopes", `${opts.scopeId}.yaml`);
  if (!existsSync(file)) throw new Error(`Scope not found: ${opts.scopeId}`);
  const yaml = parseYaml(await readFile(file, "utf8")) as Record<string, unknown>;
  applyScopeUpdate(yaml, opts);
  await writeFile(file, stringifyYaml(yaml), "utf8");
}

// `deleteScopeInDoco` was removed per the
// `scopes-are-deprecated-not-deleted` Decision. Scopes follow the same
// six-state lifecycle as every other node — to "deprecate" one,
// transition it to `abandoned` (no replacement) or `superseded` (a new
// scope took over). Existing members keep their tag; new captures are
// rejected. Use `updateScopeInDoco({ scopeId, lifecycle: "abandoned" })`
// (or "superseded") instead of deletion.

/**
 * Apply a partial update to a Doco's metadata (settings page). In
 * Postgres mode this UPDATEs the row + `raw_yaml`; the legacy CLI
 * filesystem mode rewrites `doco.yaml` in place.
 *
 *   - Each field undefined → leave it alone.
 *   - description / display_name: empty string clears the key.
 *   - visibility: only "private" or "public" accepted; other values rejected.
 *
 * Caller is expected to reindex.
 */
export interface UpdateDocoOptions {
  docoDir: string;
  description?: string | null;
  display_name?: string | null;
  visibility?: "private" | "public";
}

export async function updateDocoMeta(opts: UpdateDocoOptions): Promise<void> {
  if (opts.visibility !== undefined && opts.visibility !== "private" && opts.visibility !== "public") {
    throw new Error(`visibility must be "private" or "public", got: ${opts.visibility}`);
  }
  if (process.env.DOCO_STORAGE === "postgres") {
    // docoDir is "<root>/docos/<owner>/<slug>"; parse slugs back out.
    const parts = opts.docoDir.split("/");
    const docoSlug = parts[parts.length - 1];
    const ownerSlug = parts[parts.length - 2];
    const { withClient } = await import("@doco/db");
    await withClient(async (c) => {
      const cur = await c.query<{ raw_yaml: string }>(
        "SELECT raw_yaml FROM docos WHERE owner_slug = $1 AND doco_slug = $2 LIMIT 1",
        [ownerSlug, docoSlug],
      );
      if (!cur.rows[0]) throw new Error(`Doco "${ownerSlug}/${docoSlug}" not found.`);
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
            SET name       = $3,
                visibility = COALESCE($4, visibility),
                raw_yaml   = $5,
                updated_at = now()
          WHERE owner_slug = $1 AND doco_slug = $2`,
        [
          ownerSlug,
          docoSlug,
          (yaml.display_name as string | undefined) ?? null,
          opts.visibility ?? null,
          stringifyYaml(yaml),
        ],
      );
    });
    return;
  }
  const file = join(opts.docoDir, "doco.yaml");
  if (!existsSync(file)) throw new Error(`doco.yaml not found in ${opts.docoDir}`);
  const yaml = parseYaml(await readFile(file, "utf8")) as Record<string, unknown>;
  if (opts.description !== undefined) {
    if (opts.description === null || opts.description === "") delete yaml.description;
    else yaml.description = opts.description;
  }
  if (opts.display_name !== undefined) {
    if (opts.display_name === null || opts.display_name === "") delete yaml.display_name;
    else yaml.display_name = opts.display_name;
  }
  if (opts.visibility !== undefined) yaml.visibility = opts.visibility;
  await writeFile(file, stringifyYaml(yaml), "utf8");
}

/**
 * Rename a Doco's slug. In Postgres mode (the durable path) this updates
 * `docos.doco_slug` + `raw_yaml` in a single transaction. The legacy
 * filesystem mode (CLI fallback) renames the on-disk directory and
 * rewrites doco.yaml; callers in that mode are expected to reindex the
 * new location.
 *
 * Fails if a Doco with the target slug already exists. Does not touch
 * cross-Doco references — broken refs will surface in the next lint pass.
 */
export async function renameDocoSlug(opts: {
  root: string;
  ownerSlug: string;
  oldSlug: string;
  newSlug: string;
}): Promise<{ newDir: string }> {
  const { root, ownerSlug, oldSlug, newSlug } = opts;
  const slugError = validateDocoSlug(newSlug);
  if (slugError) throw new Error(slugError);
  if (oldSlug === newSlug) {
    return { newDir: join(hostDocosDir(root), ownerSlug, oldSlug) };
  }

  if (process.env.DOCO_STORAGE === "postgres") {
    const { withClient } = await import("@doco/db");
    await withClient(async (c) => {
      const cur = await c.query<{ raw_yaml: string }>(
        "SELECT raw_yaml FROM docos WHERE owner_slug = $1 AND doco_slug = $2 LIMIT 1",
        [ownerSlug, oldSlug],
      );
      if (!cur.rows[0]) throw new Error(`Doco "${ownerSlug}/${oldSlug}" not found.`);
      const dup = await c.query(
        "SELECT 1 FROM docos WHERE owner_slug = $1 AND doco_slug = $2 LIMIT 1",
        [ownerSlug, newSlug],
      );
      if (dup.rows[0]) throw new Error(`Doco "${ownerSlug}/${newSlug}" already exists.`);
      const yaml = parseYaml(cur.rows[0].raw_yaml) as Record<string, unknown>;
      yaml.slug = newSlug;
      await c.query(
        `UPDATE docos
            SET doco_slug  = $3,
                raw_yaml   = $4,
                updated_at = now()
          WHERE owner_slug = $1 AND doco_slug = $2`,
        [ownerSlug, oldSlug, newSlug, stringifyYaml(yaml)],
      );
    });
    return { newDir: join(hostDocosDir(root), ownerSlug, newSlug) };
  }

  const oldDir = join(hostDocosDir(root), ownerSlug, oldSlug);
  const newDir = join(hostDocosDir(root), ownerSlug, newSlug);
  if (!existsSync(oldDir)) throw new Error(`Doco "${ownerSlug}/${oldSlug}" not found.`);
  if (existsSync(newDir)) throw new Error(`Doco "${ownerSlug}/${newSlug}" already exists.`);
  await rename(oldDir, newDir);
  const yamlPath = join(newDir, "doco.yaml");
  const yaml = parseYaml(await readFile(yamlPath, "utf8")) as Record<string, unknown>;
  // Bare slug only — the owner segment is implied by the parent directory.
  // Per `fix-owner-prefix-duplicated-in-doco-slug` Intent.
  yaml.slug = newSlug;
  await writeFile(yamlPath, stringifyYaml(yaml), "utf8");
  return { newDir };
}

/**
 * Delete a Doco. In Postgres mode (the durable path) this is a hard
 * delete — `ON DELETE CASCADE` removes every entity, edge, and scope
 * tied to the Doco. The legacy filesystem mode (CLI fallback) keeps a
 * soft-delete shape: the directory is moved to `docos/<owner>/.deleted/
 * <slug>-<timestamp>/` and stays excluded from listings/routing because
 * dashboard + owner-profile listings skip `.`-prefixed directories.
 *
 * Per ADR-040 only people can call this; the route action gates by
 * `me.type === "person"`. Per `settings-page-delete-doco` Intent.
 */
export async function softDeleteDoco(opts: {
  root: string;
  ownerSlug: string;
  docoSlug: string;
}): Promise<{ deletedPath: string }> {
  const { root, ownerSlug, docoSlug } = opts;

  if (process.env.DOCO_STORAGE === "postgres") {
    // Hard-delete via ON DELETE CASCADE (intents, decisions, rules, …
    // all FK docos.id with ON DELETE CASCADE). Per `delete-is-permanent`
    // — alpha forbids back-compat soft-delete recovery. If
    // recoverability matters later, add a deleted_at column to docos and
    // switch to UPDATE.
    const { withClient } = await import("@doco/db");
    const result = await withClient((c) =>
      c.query(
        "DELETE FROM docos WHERE owner_slug = $1 AND doco_slug = $2 RETURNING id",
        [ownerSlug, docoSlug],
      ),
    );
    if (result.rowCount === 0) {
      throw new Error(`Doco "${ownerSlug}/${docoSlug}" not found.`);
    }
    return { deletedPath: `postgres:docos/${ownerSlug}/${docoSlug}` };
  }

  const docosDir = hostDocosDir(root);
  const src = join(docosDir, ownerSlug, docoSlug);
  if (!existsSync(src)) {
    throw new Error(`Doco "${ownerSlug}/${docoSlug}" not found.`);
  }
  const trashRoot = join(docosDir, ownerSlug, ".deleted");
  if (!existsSync(trashRoot)) {
    await mkdir(trashRoot, { recursive: true });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(trashRoot, `${docoSlug}-${stamp}`);
  await rename(src, dest);
  return { deletedPath: dest };
}

export async function listDocos(root: string): Promise<DocoRecord[]> {
  if (process.env.DOCO_STORAGE === "postgres") {
    const { withClient } = await import("@doco/db");
    const r = await withClient((c) =>
      c.query<{ id: string; owner_slug: string; doco_slug: string; owner_id: string }>(
        "SELECT id, owner_slug, doco_slug, owner_id FROM docos ORDER BY owner_slug, doco_slug",
      ),
    );
    return r.rows.map((row) => ({
      ownerSlug: row.owner_slug,
      docoSlug: row.doco_slug,
      ownerKind: row.owner_id.startsWith("organization_") ? "organization" : "principal",
      ownerId: row.owner_id as EntityId<"principal"> | EntityId<"organization">,
      docoId: row.id as EntityId<"doco">,
      path: hostDocoDir(root, row.owner_slug, row.doco_slug),
    }));
  }
  if (detectMode(root) !== "host") throw new Error("Not a Host directory");
  const out: DocoRecord[] = [];
  const docosDir = hostDocosDir(root);
  if (!existsSync(docosDir)) return out;
  for (const ownerSlug of await readdir(docosDir)) {
    if (ownerSlug.startsWith(".")) continue; // skip .deleted/, .DS_Store, etc.
    const ownerDir = join(docosDir, ownerSlug);
    const ownerStat = await stat(ownerDir);
    if (!ownerStat.isDirectory()) continue;
    for (const docoSlug of await readdir(ownerDir)) {
      if (docoSlug.startsWith(".")) continue; // skip .deleted/, .DS_Store, etc.
      const dir = join(ownerDir, docoSlug);
      const ds = await stat(dir);
      if (!ds.isDirectory()) continue;
      const yamlPath = join(dir, "doco.yaml");
      if (!existsSync(yamlPath)) continue;
      const data = parseYaml(await readFile(yamlPath, "utf8")) as Record<string, unknown>;
      const ownerId = data.owner_id as string;
      const ownerKind = ownerId.startsWith("organization_") ? "organization" : "principal";
      out.push({
        ownerSlug,
        docoSlug,
        ownerKind,
        ownerId: ownerId as EntityId<"principal"> | EntityId<"organization">,
        docoId: data.id as EntityId<"doco">,
        path: dir,
      });
    }
  }
  return out;
}
