/**
 * URL conventions and reserved ids — single source of truth.
 *
 * Collection URLs are `/<collection-handle>/...`. The handle is requested at
 * creation time; it lives in the same flat namespace as the top-level
 * host routes, so the reserved-id set below prevents collisions.
 *
 * Entity URLs are `/<collection-handle>/<type>/<id>` where `<id>` is the
 * entity's ULID (e.g. `decision_01KRHB95AVGFHG80B2EAWE20K8`).
 */

import type { EntityType } from "./branded.js";

/**
 * Top-level path segments that exist as host routes. A collection's
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
  "forgot-password",
  "choose-password",
  "confirm-email",
  "new-collection",
  "new",
  "collections",
  "workspaces",
  "admin",
  "settings",
  "profile",
  "help",
  "about",
  "terms",
  "dashboard",
  "feedback",
  "mentor",
  "onboarding",
  "agents",
  "agent",
  "auth",
  "cli",
  "invite",
  "digest",
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
  collectionHandle: string;
  /** Entity type discriminator string. */
  nodeType: string;
  /** Entity ULID id (`<type>_<ULID>`). */
  id: string;
}

function collectionPrefix(input: { collectionHandle: string }): string {
  return `/${input.collectionHandle}`;
}

/** Canonical URL for an entity — short form, no `/e/`. */
export function entityUrl(input: EntityUrlInput): string {
  const prefix = collectionPrefix(input);
  return `${prefix}/${input.nodeType}/${input.id}`;
}

export interface CollectionUrlInput {
  collectionHandle: string;
}

export function collectionUrl(input: CollectionUrlInput): string {
  return collectionPrefix(input);
}

/**
 * Validate a requested collection handle. Must be globally unique once
 * stored; this validator only checks shape — collision handling is
 * the create-flow's job (auto-suffix on conflict).
 */
export function validateRequestedCollectionHandle(handle: string): string | null {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(handle)) {
    return `Invalid collection handle "${handle}" — expected a URL-safe handle ([a-z0-9][a-z0-9_-]*).`;
  }
  if (handle.length > 64) {
    return `Collection handle "${handle}" is too long (max 64 chars).`;
  }
  if (handle.includes("/")) {
    return `Collection handle "${handle}" must not contain '/'.`;
  }
  if (HOST_RESERVED_SLUGS.has(handle)) {
    return `Collection handle "${handle}" is reserved by collection's URL routing.`;
  }
  return null;
}
