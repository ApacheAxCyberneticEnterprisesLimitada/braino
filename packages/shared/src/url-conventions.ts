/**
 * URL conventions and reserved slugs — single source of truth.
 *
 * Two namespaces are reserved at the **host level**: Principal usernames
 * and Organization slugs. A user can't be named `dashboard` because the
 * route `/dashboard` already exists. Per ADR-067.
 *
 * Entity URLs are `/<owner>/<doco>/<type>/<id>` where `<id>` is the
 * entity's ULID (e.g. `decision_01KRHB95AVGFHG80B2EAWE20K8`). Entities
 * no longer carry slugs — the ULID is the only id; agents/users read
 * the entity's `summary` field for readable identification.
 */

/**
 * Top-level path segments that exist as host routes. Principal usernames
 * and Organization slugs are rejected if they match one of these.
 */
export const HOST_RESERVED_SLUGS: ReadonlySet<string> = new Set([
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
  "dashboard",
  "onboarding",
  "agents",
  "auth",
  "cli",
  "_",
  ".",
  "..",
]);

/**
 * Entity node types — used as URL segments in the short form.
 */
export const ENTITY_TYPES = [
  "principal",
  "doco",
  "organization",
  "intent",
  "idea",
  "rule",
  "decision",
  "action",
  "eval",
  "reference",
  "scope",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

const ENTITY_TYPES_SET: ReadonlySet<string> = new Set(ENTITY_TYPES);

export function isEntityType(s: string): s is EntityType {
  return ENTITY_TYPES_SET.has(s);
}

export interface EntityUrlInput {
  ownerSlug: string;
  docoSlug: string;
  nodeType: string;
  /** Entity ULID id (`<type>_<ULID>`). */
  id: string;
}

/**
 * Canonical URL for an entity — short form, no `/e/`.
 *
 * Per decision_01KRPNZY7W6CCMYNKGND67BP0B scopes use the plural form
 * `/scopes/<id>` so the merged detail+edit page lives at one stable URL.
 * Every other node type uses the singular-type short form.
 */
export function entityUrl({ ownerSlug, docoSlug, nodeType, id }: EntityUrlInput): string {
  if (nodeType === "scope") return `/${ownerSlug}/${docoSlug}/scopes/${id}`;
  return `/${ownerSlug}/${docoSlug}/${nodeType}/${id}`;
}

export interface EntityListUrlInput {
  ownerSlug: string;
  docoSlug: string;
  nodeType: string;
}

export function entityListUrl({ ownerSlug, docoSlug, nodeType }: EntityListUrlInput): string {
  return `/${ownerSlug}/${docoSlug}/${nodeType}`;
}

/**
 * Legacy `/e/<type>/<id>` URL — kept as the redirect source. Useful in
 * migrations / tests that need to verify the redirect works.
 */
export function legacyEntityUrl({ ownerSlug, docoSlug, nodeType, id }: EntityUrlInput): string {
  return `/${ownerSlug}/${docoSlug}/e/${nodeType}/${id}`;
}

export interface DocoUrlInput {
  ownerSlug: string;
  docoSlug: string;
}

export function docoUrl({ ownerSlug, docoSlug }: DocoUrlInput): string {
  return `/${ownerSlug}/${docoSlug}`;
}

/**
 * Validate a Doco slug (per-owner). Must not contain a slash (the
 * `<owner>/<doco>` compound is constructed, not stored).
 */
export function validateDocoSlug(slug: string): string | null {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) {
    return `Invalid Doco slug "${slug}" — expected kebab-case ([a-z0-9][a-z0-9_-]*).`;
  }
  if (slug.length > 64) {
    return `Doco slug "${slug}" is too long (max 64 chars).`;
  }
  if (slug.includes("/")) {
    return `Doco slug "${slug}" must not contain '/'. Store the bare slug; the owner segment is implied by the parent directory.`;
  }
  return null;
}
