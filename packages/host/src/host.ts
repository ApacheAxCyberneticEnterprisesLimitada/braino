import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
} from "@doco/shared";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  detectMode,
  hostDocoDir,
  hostDocosDir,
  hostOrganizationsDir,
  hostPrincipalsDir,
  hostSchemaPath,
  hostYamlPath,
} from "./mode.js";

export interface HostConfig {
  id: string; // host_<ulid> — meta-Doco style
  schema_version: string;
  name: string;
  created_at: string;
  created_by: EntityId<"principal"> | null;
  visibility: "private" | "public";
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// templates/ ships in @doco/cli; @doco/host pulls the schema from the canonical location.
// Resolution order: explicit override (env), bundled with cli (../../cli/templates), fallback to repo schema/.
function locateSchemaTemplate(): string {
  const env = process.env.DOCO_SCHEMA_TEMPLATE;
  if (env && existsSync(env)) return env;
  const cliTemplate = join(__dirname, "..", "..", "cli", "templates", "doco.schema.json");
  if (existsSync(cliTemplate)) return cliTemplate;
  // Fallback: walk up to find the repo's canonical schema.
  let cur = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = join(cur, "schema", "doco.schema.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new Error("Cannot locate doco.schema.json template");
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
      // host bootstrap: principals at host level live without a single doco_id;
      // we synthesize a host self-id below for the schema's required field.
      doco_id: ("doco_" + generateUlid()) as EntityId<"doco">,
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
    "# Per-Doco SQLite caches (regenerable)\n**/.doco/\n# Host-level token store / cache (deferred)\n.doco-host/\n# OS\n.DS_Store\n",
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
 * Slugs that name top-level @doco/web routes — rejected by addPrincipal /
 * addOrganization / createDocoInHost so a User or Org can never collide
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
  "new-doco",
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

function assertSlugAllowed(slug: string, kind: "principal" | "organization" | "doco"): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `Invalid ${kind} slug "${slug}" — expected kebab-case [a-z0-9_-]+ (ADR-067).`,
    );
  }
  if (RESERVED_SLUGS.has(slug)) {
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
    doco_id: ("doco_" + generateUlid()) as EntityId<"doco">,
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
    scopes: [],
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
    doco_id: ("doco_" + generateUlid()) as EntityId<"doco">,
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
    scopes: [],
  };
  await writeFile(
    join(hostOrganizationsDir(root), `${id}.yaml`),
    stringifyYaml(yaml),
    "utf8",
  );
  return id;
}

// ──────────────────────────────────────────────────────────────────────────
// Docos in a host
// ──────────────────────────────────────────────────────────────────────────

export interface CreateDocoInHostOptions {
  ownerSlug: string; // resolves to user or org
  docoSlug: string;
  description?: string;
  visibility?: "private" | "public";
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
  if (detectMode(root) !== "host") throw new Error("Not a Host directory");
  assertSlugAllowed(opts.docoSlug, "doco");
  const owner = await resolveOwnerSlug(root, opts.ownerSlug);
  if (!owner) {
    throw new Error(`Owner "${opts.ownerSlug}" not found in this host.`);
  }
  const dir = hostDocoDir(root, opts.ownerSlug, opts.docoSlug);
  if (existsSync(dir)) {
    throw new Error(`Doco already exists at ${dir}.`);
  }

  // Build the per-Doco subtree.
  await mkdir(dir, { recursive: true });
  for (const sub of [
    "schema",
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
    "evaluations",
  ]) {
    await mkdir(join(dir, sub), { recursive: true });
  }
  // Share schema via copy from host (or symlink in future).
  await copyFile(hostSchemaPath(root), join(dir, "schema", "doco.schema.json"));

  const docoId = makeEntityId("doco", generateUlid()) as EntityId<"doco">;
  const created = nowIso();
  const docoYaml = {
    id: docoId,
    node_type: "doco",
    schema_version: "0.1",
    slug: `${opts.ownerSlug}/${opts.docoSlug}`,
    display_name: opts.docoSlug,
    visibility: opts.visibility ?? "private",
    default_branch: "main",
    owner_id: owner.id,
    description:
      opts.description ?? `Doco created in host (owned by ${owner.kind} "${opts.ownerSlug}").`,
    summary: `Created in host on ${created}.`,
    created_at: created,
    created_by: owner.kind === "principal" ? owner.id : null,
    revision: 1,
    lifecycle: "active",
    status: "active",
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
    `# ${opts.docoSlug}\n\nOwner: ${owner.kind} \`${opts.ownerSlug}\`.\n`,
    "utf8",
  );
  await writeFile(
    join(dir, ".gitignore"),
    "# Local cache — regenerable\n.doco/\n",
    "utf8",
  );

  return {
    ownerSlug: opts.ownerSlug,
    docoSlug: opts.docoSlug,
    ownerKind: owner.kind,
    ownerId: owner.id,
    docoId,
    path: dir,
  };
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
  description?: string;
  /** Why this scope exists (ADR-082). */
  purpose?: string;
  /** Markdown guidance on how to author nodes in this scope (ADR-082). */
  guidelines?: string;
  /** Parent scopes — semantically "this scope belongs to those." (ADR-081) */
  parentScopes?: EntityId<"scope">[];
  createdBy: EntityId<"principal"> | null;
}

export async function createScopeInDoco(
  opts: CreateScopeOptions,
): Promise<EntityId<"scope">> {
  const id = makeEntityId("scope", generateUlid()) as EntityId<"scope">;
  const created = nowIso();
  const yaml: Record<string, unknown> = {
    id,
    doco_id: opts.docoId,
    node_type: "scope",
    schema_version: "0.1",
    summary: opts.description?.trim() || opts.purpose?.trim() || `Scope: ${opts.name}`,
    name: opts.name,
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.purpose ? { purpose: opts.purpose } : {}),
    ...(opts.guidelines ? { guidelines: opts.guidelines } : {}),
    created_at: created,
    created_by: opts.createdBy,
    revision: 1,
    lifecycle: "active",
    status: "active",
    scopes: opts.parentScopes ?? [],
  };
  const dir = join(opts.docoDir, "scopes");
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.yaml`), stringifyYaml(yaml), "utf8");
  return id;
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
  ) => { purpose?: string; guidelines?: string } | undefined;
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
          ...(tpl?.purpose ? { purpose: tpl.purpose } : {}),
          ...(tpl?.guidelines ? { guidelines: tpl.guidelines } : {}),
          ...(parentId ? { parentScopes: [parentId] } : {}),
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
    s.yaml.revision = (typeof s.yaml.revision === "number" ? s.yaml.revision : 1) + 1;
    await writeFile(join(dir, s.file), stringifyYaml(s.yaml), "utf8");
    flatByName.set(leafName, s.id);
    renamed += 1;
  }
  return { created, renamed };
}

/**
 * Apply a partial update to a Scope's YAML on disk (ADR-084 — scope mgmt UX).
 *
 * Each field is independently optional. Pass:
 *   - `undefined` to leave it as-is
 *   - `null` or empty-string to clear the field (delete the YAML key)
 *   - a non-empty value to set it
 *
 * Bumps `revision` on every successful write. Caller is expected to reindex
 * after. Throws if the file doesn't exist.
 */
export interface UpdateScopeOptions {
  docoDir: string;
  scopeId: EntityId<"scope">;
  purpose?: string | null;
  guidelines?: string | null;
  /** Replace the entire parent list (not append). Pass [] to clear. */
  parentScopes?: EntityId<"scope">[];
}

export async function updateScopeInDoco(opts: UpdateScopeOptions): Promise<void> {
  const file = join(opts.docoDir, "scopes", `${opts.scopeId}.yaml`);
  if (!existsSync(file)) throw new Error(`Scope not found: ${opts.scopeId}`);
  const yaml = parseYaml(await readFile(file, "utf8")) as Record<string, unknown>;
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
  yaml.revision = (typeof yaml.revision === "number" ? yaml.revision : 1) + 1;
  await writeFile(file, stringifyYaml(yaml), "utf8");
}

/**
 * Delete a Scope's YAML file on disk (ADR-084).
 *
 * The caller is responsible for checking refbacks (members + sub-scopes).
 * This helper only removes the file — orphan-ref lint will surface any
 * dangling references after the next reindex.
 */
export async function deleteScopeInDoco(opts: {
  docoDir: string;
  scopeId: EntityId<"scope">;
}): Promise<void> {
  const file = join(opts.docoDir, "scopes", `${opts.scopeId}.yaml`);
  if (!existsSync(file)) throw new Error(`Scope not found: ${opts.scopeId}`);
  await rm(file);
}

export async function listDocos(root: string): Promise<DocoRecord[]> {
  if (detectMode(root) !== "host") throw new Error("Not a Host directory");
  const out: DocoRecord[] = [];
  const docosDir = hostDocosDir(root);
  if (!existsSync(docosDir)) return out;
  for (const ownerSlug of await readdir(docosDir)) {
    const ownerDir = join(docosDir, ownerSlug);
    const ownerStat = await stat(ownerDir);
    if (!ownerStat.isDirectory()) continue;
    for (const docoSlug of await readdir(ownerDir)) {
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
