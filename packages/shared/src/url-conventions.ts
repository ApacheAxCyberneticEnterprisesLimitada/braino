/**
 * URL conventions and reserved ids — single source of truth.
 *
 * Doco URLs are `/<doco-id>/...`. The Doco id is the human-readable
 * handle requested at creation time; it lives in the same flat
 * namespace as the top-level host routes, so the reserved-id set
 * below prevents collisions.
 *
 * Entity URLs are `/<doco-id>/<type>/<id>` where `<id>` is the
 * entity's ULID (e.g. `decision_01KRHB95AVGFHG80B2EAWE20K8`).
 */

/**
 * Top-level path segments that exist as host routes. A doco's
 * requested id is rejected if it matches one of these.
 */
export const HOST_RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "e",
  "host",
  "api",
  "search",
  "find-rules",
  "sign-in",
  "sign-out",
  "sign-up",
  "new-doco",
  "new",
  "orgs",
  "admin",
  "settings",
  "profile",
  "help",
  "about",
  "dashboard",
  "onboarding",
  "agents",
  "agent",
  "auth",
  "cli",
  "invite",
  "by-id",
  "_",
  ".",
  "..",
]);

/**
 * Entity node types — used as URL segments in the short form.
 *
 * v15 (decision_01KS3DW9C2KN2X7Z80R18H1RAX) removed `scope` from the
 * navigable set. Legacy raw_yaml may still mention scope nodes but
 * the URL layer rejects `scope` as an entity type.
 */
export const ENTITY_TYPES = [
  "principal",
  "doco",
  "organization",
  "intent",
  "idea",
  "rule",
  "guidance_article",
  "node_authoring_article",
  "decision",
  "action",
  "log",
  "eval",
  "reference",
  "state",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

const ENTITY_TYPES_SET: ReadonlySet<string> = new Set(ENTITY_TYPES);

export function isEntityType(s: string): s is EntityType {
  return ENTITY_TYPES_SET.has(s);
}

/**
 * URL builders accept either the legacy `(ownerSlug, docoSlug)` pair
 * (current route shape `/<doco-handle>/...`) or a single `docoId`
 * (phase-2 route shape `/<doco-id>/...`). Callers that supply `docoId`
 * win; otherwise the function falls back to the slug pair.
 */
export interface EntityUrlInput {
  /** Phase 2: globally-unique handle. When set, takes precedence. */
  docoId?: string;
  ownerSlug?: string;
  docoSlug?: string;
  nodeType: string;
  /** Entity ULID id (`<type>_<ULID>`). */
  id: string;
}

function docoPrefix(input: { docoId?: string; ownerSlug?: string; docoSlug?: string }): string {
  // Phase 3a+: every route uses `/<handle>/...` and `docoSlug` from
  // `mapDocoRow` mirrors `handle` already. `docoId`, when set, is the
  // canonical handle/ULID. `docoSlug`, when set, is the handle too (the
  // legacy slug-only form no longer exists in storage). Either field
  // is a valid URL identifier as-is — DO NOT re-synthesize with the
  // owner prefix or URLs become `/<owner>-<handle>/...` (the doubled
  // prefix bug).
  if (input.docoId) return `/${input.docoId}`;
  if (input.docoSlug) return `/${input.docoSlug}`;
  if (input.ownerSlug) return `/${input.ownerSlug}`;
  return "";
}

/**
 * Canonical URL for an entity — short form, no `/e/`.
 *
 * v15 removed the dedicated `/scopes/<id>` URL; scope entities fall
 * through to the generic `/<doco>/<nodeType>/<id>` path (which 404s
 * because `scope` is no longer a valid entity type).
 */
export function entityUrl(input: EntityUrlInput): string {
  const prefix = docoPrefix(input);
  return `${prefix}/${input.nodeType}/${input.id}`;
}

export interface EntityListUrlInput {
  docoId?: string;
  ownerSlug?: string;
  docoSlug?: string;
  nodeType: string;
}

export function entityListUrl(input: EntityListUrlInput): string {
  return `${docoPrefix(input)}/${input.nodeType}`;
}

/** Legacy `/e/<type>/<id>` URL — kept as the redirect source. */
export function legacyEntityUrl(input: EntityUrlInput): string {
  return `${docoPrefix(input)}/e/${input.nodeType}/${input.id}`;
}

export interface DocoUrlInput {
  docoId?: string;
  ownerSlug?: string;
  docoSlug?: string;
}

export function docoUrl(input: DocoUrlInput): string {
  return docoPrefix(input);
}

/**
 * Validate a requested Doco id. Must be globally unique once
 * stored; this validator only checks shape — collision handling is
 * the create-flow's job (auto-suffix on conflict).
 */
export function validateRequestedDocoId(id: string): string | null {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    return `Invalid Doco id "${id}" — expected kebab-case ([a-z0-9][a-z0-9_-]*).`;
  }
  if (id.length > 64) {
    return `Doco id "${id}" is too long (max 64 chars).`;
  }
  if (id.includes("/")) {
    return `Doco id "${id}" must not contain '/'.`;
  }
  if (HOST_RESERVED_SLUGS.has(id)) {
    return `Doco id "${id}" is reserved by Doco's URL routing.`;
  }
  return null;
}

/**
 * Normalize an arbitrary string into a candidate Doco id — lowercase,
 * collapse runs of non-alphanumerics into `-`, strip leading/trailing
 * dashes, truncate to 64 chars. Returns null if nothing survives.
 */
export function normalizeRequestedDocoId(input: string): string | null {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 64);
  if (!normalized || !/^[a-z0-9]/.test(normalized)) return null;
  return normalized;
}

/**
 * @deprecated Compat alias for callers that still construct legacy
 * `(ownerSlug, docoSlug)` URLs. Forwards to `validateRequestedDocoId`.
 */
export const validateDocoSlug = validateRequestedDocoId;
