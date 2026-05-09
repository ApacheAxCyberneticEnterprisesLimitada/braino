import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type EntityId,
  type Organization,
  type Principal,
  generateUlid,
  makeEntityId,
  nowIso,
} from "@evalo/shared";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  detectMode,
  hostEvaloDir,
  hostEvalosDir,
  hostOrganizationsDir,
  hostPrincipalsDir,
  hostSchemaPath,
  hostYamlPath,
} from "./mode.js";

export interface HostConfig {
  id: string; // host_<ulid> — meta-Evalo style
  schema_version: string;
  name: string;
  created_at: string;
  created_by: EntityId<"principal"> | null;
  visibility: "private" | "public";
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// templates/ ships in @evalo/cli; @evalo/host pulls the schema from the canonical location.
// Resolution order: explicit override (env), bundled with cli (../../cli/templates), fallback to repo schema/.
function locateSchemaTemplate(): string {
  const env = process.env.EVALO_SCHEMA_TEMPLATE;
  if (env && existsSync(env)) return env;
  const cliTemplate = join(__dirname, "..", "..", "cli", "templates", "evalo.schema.json");
  if (existsSync(cliTemplate)) return cliTemplate;
  // Fallback: walk up to find the repo's canonical schema.
  let cur = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = join(cur, "schema", "evalo.schema.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new Error("Cannot locate evalo.schema.json template");
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
    throw new Error(`Refusing to overwrite: ${root} is already a Host or Evalo.`);
  }
  await mkdir(root, { recursive: true });
  await mkdir(hostPrincipalsDir(root), { recursive: true });
  await mkdir(hostOrganizationsDir(root), { recursive: true });
  await mkdir(hostEvalosDir(root), { recursive: true });
  await mkdir(join(root, "schema"), { recursive: true });

  // Copy the canonical schema.
  await copyFile(locateSchemaTemplate(), hostSchemaPath(root));

  // Optional bootstrap Principal.
  let bootstrapId: EntityId<"principal"> | null = null;
  if (opts.ownerUsername) {
    const created = nowIso();
    const id = makeEntityId("principal", generateUlid()) as EntityId<"principal">;
    const principal: Principal = {
      id,
      // host bootstrap: principals at host level live without a single evalo_id;
      // we synthesize a host self-id below for the schema's required field.
      evalo_id: ("evalo_" + generateUlid()) as EntityId<"evalo">,
      node_type: "principal",
      schema_version: "0.1",
      summary: `Host owner ${opts.ownerUsername}.`,
      type: "human",
      username: opts.ownerUsername,
      display_name: opts.ownerUsername,
      ...(opts.ownerEmail
        ? { github_identity: { github_login: opts.ownerUsername, email: opts.ownerEmail } }
        : { github_identity: { github_login: opts.ownerUsername } }),
      created_at: created,
      created_by: id,
      revision: 1,
      lifecycle: "active",
      status: "active",
      tags: [],
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
    "# Per-Evalo SQLite caches (regenerable)\n**/.evalo/\n# Host-level token store / cache (deferred)\n.evalo-host/\n# OS\n.DS_Store\n",
    "utf8",
  );
  await writeFile(
    join(root, "README.md"),
    `# ${opts.name}\n\nA multi-tenant Evalo Host. See [ADR-061](https://example.invalid).\n\n` +
      "## Quick start\n\n" +
      "```bash\nevalo host user create alice\nevalo host org create my-org --owner alice\nevalo host evalo new alice/my-evalo\nevalo host list\n```\n",
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
  return listEntitiesAs(hostPrincipalsDir(root), "principal", (e) => ({
    kind: "principal",
    id: e.id as EntityId<"principal">,
    slug: e.username as string,
    display_name: (e.display_name as string) ?? (e.username as string),
  }));
}

export async function listOrganizations(root: string): Promise<OwnerSummary[]> {
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
 * Slugs that name top-level @evalo/web routes — rejected by addPrincipal /
 * addOrganization / createEvaloInHost so a User or Org can never collide
 * with the URL routing layer (ADR-067).
 */
export const RESERVED_SLUGS = new Set([
  "e",
  "host",
  "api",
  "search",
  "lint",
  "find-rules",
  "sign-in",
  "sign-out",
  "sign-up",
  "new-evalo",
  "new-org",
  "new",
  "admin",
  "settings",
  "profile",
  "help",
  "about",
  "_",
  ".",
  "..",
]);

const SLUG_PATTERN = /^[a-z0-9_-]+$/;

function assertSlugAllowed(slug: string, kind: "principal" | "organization" | "evalo"): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `Invalid ${kind} slug "${slug}" — expected kebab-case [a-z0-9_-]+ (ADR-067).`,
    );
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new Error(
      `Slug "${slug}" is reserved by Evalo's URL routing (ADR-067). Pick a different name.`,
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
}

export async function addPrincipal(
  root: string,
  opts: AddPrincipalOptions,
): Promise<EntityId<"principal">> {
  if (detectMode(root) !== "host") throw new Error("Not a Host directory");
  await assertSlugFree(root, opts.username, "principal");
  const id = makeEntityId("principal", generateUlid()) as EntityId<"principal">;
  const created = nowIso();
  const yaml: Principal = {
    id,
    evalo_id: ("evalo_" + generateUlid()) as EntityId<"evalo">,
    node_type: "principal",
    schema_version: "0.1",
    summary: `User ${opts.username}.`,
    type: "human",
    username: opts.username,
    display_name: opts.display_name ?? opts.username,
    ...(opts.email
      ? { github_identity: { github_login: opts.username, email: opts.email } }
      : { github_identity: { github_login: opts.username } }),
    created_at: created,
    created_by: id,
    revision: 1,
    lifecycle: "active",
    status: "active",
    tags: [],
  };
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
  if (detectMode(root) !== "host") throw new Error("Not a Host directory");
  await assertSlugFree(root, opts.slug, "organization");
  const owner = await resolveOwnerSlug(root, opts.ownerUsername);
  if (!owner || owner.kind !== "principal") {
    throw new Error(`Owner "${opts.ownerUsername}" not found as a User in this host.`);
  }
  const id = makeEntityId("organization", generateUlid()) as EntityId<"organization">;
  const created = nowIso();
  const yaml: Organization = {
    id,
    evalo_id: ("evalo_" + generateUlid()) as EntityId<"evalo">,
    node_type: "organization",
    schema_version: "0.1",
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
    revision: 1,
    lifecycle: "active",
    status: "active",
    tags: [],
  };
  await writeFile(
    join(hostOrganizationsDir(root), `${id}.yaml`),
    stringifyYaml(yaml),
    "utf8",
  );
  return id;
}

// ──────────────────────────────────────────────────────────────────────────
// Evalos in a host
// ──────────────────────────────────────────────────────────────────────────

export interface CreateEvaloInHostOptions {
  ownerSlug: string; // resolves to user or org
  evaloSlug: string;
  description?: string;
  visibility?: "private" | "public";
}

export interface EvaloRecord {
  ownerSlug: string;
  evaloSlug: string;
  ownerKind: "principal" | "organization";
  ownerId: EntityId<"principal"> | EntityId<"organization">;
  evaloId: EntityId<"evalo">;
  path: string;
}

export async function createEvaloInHost(
  root: string,
  opts: CreateEvaloInHostOptions,
): Promise<EvaloRecord> {
  if (detectMode(root) !== "host") throw new Error("Not a Host directory");
  assertSlugAllowed(opts.evaloSlug, "evalo");
  const owner = await resolveOwnerSlug(root, opts.ownerSlug);
  if (!owner) {
    throw new Error(`Owner "${opts.ownerSlug}" not found in this host.`);
  }
  const dir = hostEvaloDir(root, opts.ownerSlug, opts.evaloSlug);
  if (existsSync(dir)) {
    throw new Error(`Evalo already exists at ${dir}.`);
  }

  // Build the per-Evalo subtree.
  await mkdir(dir, { recursive: true });
  for (const sub of [
    "schema",
    "principals",
    "intents",
    "rules",
    "decisions",
    "actions",
    "reasoning",
    "references",
    "tags",
    "organizations",
    "evaluations",
  ]) {
    await mkdir(join(dir, sub), { recursive: true });
  }
  // Share schema via copy from host (or symlink in future).
  await copyFile(hostSchemaPath(root), join(dir, "schema", "evalo.schema.json"));

  const evaloId = makeEntityId("evalo", generateUlid()) as EntityId<"evalo">;
  const created = nowIso();
  const evaloYaml = {
    id: evaloId,
    node_type: "evalo",
    schema_version: "0.1",
    slug: `${opts.ownerSlug}/${opts.evaloSlug}`,
    display_name: opts.evaloSlug,
    visibility: opts.visibility ?? "private",
    default_branch: "main",
    owner_id: owner.id,
    description:
      opts.description ?? `Evalo created in host (owned by ${owner.kind} "${opts.ownerSlug}").`,
    summary: `Created in host on ${created}.`,
    created_at: created,
    created_by: owner.kind === "principal" ? owner.id : null,
    revision: 1,
    lifecycle: "active",
    status: "active",
    tags: [] as string[],
    members:
      owner.kind === "principal"
        ? [{ principal_id: owner.id, role: "owner", permissions: ["read", "write", "execute", "admin"] }]
        : [],
    imports: [] as unknown[],
  };
  await writeFile(join(dir, "evalo.yaml"), stringifyYaml(evaloYaml), "utf8");
  await writeFile(
    join(dir, "README.md"),
    `# ${opts.evaloSlug}\n\nOwner: ${owner.kind} \`${opts.ownerSlug}\`.\n`,
    "utf8",
  );
  await writeFile(
    join(dir, ".gitignore"),
    "# Local cache — regenerable\n.evalo/\n",
    "utf8",
  );

  return {
    ownerSlug: opts.ownerSlug,
    evaloSlug: opts.evaloSlug,
    ownerKind: owner.kind,
    ownerId: owner.id,
    evaloId,
    path: dir,
  };
}

export async function listEvalos(root: string): Promise<EvaloRecord[]> {
  if (detectMode(root) !== "host") throw new Error("Not a Host directory");
  const out: EvaloRecord[] = [];
  const evalosDir = hostEvalosDir(root);
  if (!existsSync(evalosDir)) return out;
  for (const ownerSlug of await readdir(evalosDir)) {
    const ownerDir = join(evalosDir, ownerSlug);
    const ownerStat = await stat(ownerDir);
    if (!ownerStat.isDirectory()) continue;
    for (const evaloSlug of await readdir(ownerDir)) {
      const dir = join(ownerDir, evaloSlug);
      const ds = await stat(dir);
      if (!ds.isDirectory()) continue;
      const yamlPath = join(dir, "evalo.yaml");
      if (!existsSync(yamlPath)) continue;
      const data = parseYaml(await readFile(yamlPath, "utf8")) as Record<string, unknown>;
      const ownerId = data.owner_id as string;
      const ownerKind = ownerId.startsWith("organization_") ? "organization" : "principal";
      out.push({
        ownerSlug,
        evaloSlug,
        ownerKind,
        ownerId: ownerId as EntityId<"principal"> | EntityId<"organization">,
        evaloId: data.id as EntityId<"evalo">,
        path: dir,
      });
    }
  }
  return out;
}
