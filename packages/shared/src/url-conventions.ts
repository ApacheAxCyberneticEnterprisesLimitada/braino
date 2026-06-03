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
  "workspaces",
  "admin",
  "settings",
  "profile",
  "help",
  "about",
  "dashboard",
  "feedback",
  "mentor",
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

export interface EntityUrlInput {
  docoHandle: string;
  /** Entity type discriminator string. */
  entityType: string;
  /** Entity ULID id (`<type>_<ULID>`). */
  id: string;
}

function docoPrefix(input: { docoHandle: string }): string {
  return `/${input.docoHandle}`;
}

/** Canonical URL for an entity — short form, no `/e/`. */
export function entityUrl(input: EntityUrlInput): string {
  const prefix = docoPrefix(input);
  return `${prefix}/${input.entityType}/${input.id}`;
}

export interface DocoUrlInput {
  docoHandle: string;
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
    return `Invalid Doco handle "${handle}" — expected a URL-safe handle ([a-z0-9][a-z0-9_-]*).`;
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
