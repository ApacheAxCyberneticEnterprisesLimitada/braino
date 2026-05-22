/**
 * URL conventions and reserved ids — single source of truth.
 *
 * Doco URLs are `/<doco-handle>/...`. The handle is requested at
 * creation time; it lives in the same flat namespace as the top-level
 * host routes, so the reserved-id set below prevents collisions.
 *
 * Entity URLs are `/<doco-handle>/<type>/<id>` where `<id>` is the
 * entity's ULID (e.g. `decision_01KRHB95AVGFHG80B2EAWE20K8`).
 */

import type { EntityType } from "./branded.js";

/**
 * Top-level path segments that exist as host routes. A doco's
 * requested handle is rejected if it matches one of these.
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
  "docos",
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
 * Entity types — used as URL segments in the short form.
 * Source of truth lives in branded.ts. The barrel re-exports both
 * `ENTITY_TYPES` and `isEntityType` from there; url-conventions itself
 * doesn't re-export to avoid duplicate-export ambiguity.
 */
export type { EntityType };

/**
 * URL builders accept the current `docoHandle`, the legacy
 * `(ownerSlug, docoSlug)` pair, or the old `docoId` alias.
 */
export interface EntityUrlInput {
  /** Current public route handle. When set, takes precedence. */
  docoHandle?: string;
  /** Compatibility alias for callers that still pass the route handle as `docoId`. */
  docoId?: string;
  ownerSlug?: string;
  docoSlug?: string;
  /** Entity type discriminator string. */
  entityType: string;
  /** Entity ULID id (`<type>_<ULID>`). */
  id: string;
}

function docoPrefix(input: {
  docoHandle?: string;
  docoId?: string;
  ownerSlug?: string;
  docoSlug?: string;
}): string {
  if (input.docoHandle) return `/${input.docoHandle}`;
  if (input.docoId) return `/${input.docoId}`;
  if (input.docoSlug) return `/${input.docoSlug}`;
  if (input.ownerSlug) return `/${input.ownerSlug}`;
  return "";
}

/** Canonical URL for an entity — short form, no `/e/`. */
export function entityUrl(input: EntityUrlInput): string {
  const prefix = docoPrefix(input);
  return `${prefix}/${input.entityType}/${input.id}`;
}

export interface EntityListUrlInput {
  docoHandle?: string;
  docoId?: string;
  ownerSlug?: string;
  docoSlug?: string;
  entityType: string;
}

export function entityListUrl(input: EntityListUrlInput): string {
  return `${docoPrefix(input)}/${input.entityType}`;
}

export interface DocoUrlInput {
  docoHandle?: string;
  docoId?: string;
  ownerSlug?: string;
  docoSlug?: string;
}

export function docoUrl(input: DocoUrlInput): string {
  return docoPrefix(input);
}

/**
 * Validate a requested Doco handle. Must be globally unique once
 * stored; this validator only checks shape — collision handling is
 * the create-flow's job (auto-suffix on conflict).
 */
export function validateRequestedDocoHandle(handle: string): string | null {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(handle)) {
    return `Invalid Doco handle "${handle}" — expected kebab-case ([a-z0-9][a-z0-9_-]*).`;
  }
  if (handle.length > 64) {
    return `Doco handle "${handle}" is too long (max 64 chars).`;
  }
  if (handle.includes("/")) {
    return `Doco handle "${handle}" must not contain '/'.`;
  }
  if (HOST_RESERVED_SLUGS.has(handle)) {
    return `Doco handle "${handle}" is reserved by Doco's URL routing.`;
  }
  return null;
}

/**
 * Compatibility alias for older code that used "id" for the public route handle.
 */
export function validateRequestedDocoId(handle: string): string | null {
  return validateRequestedDocoHandle(handle);
}

/**
 * Normalize an arbitrary string into a candidate Doco handle — lowercase,
 * collapse runs of non-alphanumerics into `-`, strip leading/trailing
 * dashes, truncate to 64 chars. Returns null if nothing survives.
 */
export function normalizeRequestedDocoHandle(input: string): string | null {
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
 * Compatibility alias for older code that used "id" for the public route handle.
 */
export function normalizeRequestedDocoId(input: string): string | null {
  return normalizeRequestedDocoHandle(input);
}
