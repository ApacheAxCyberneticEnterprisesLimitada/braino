// @doco/db — Postgres adapter for Doco source-of-truth storage.
// Phase 2 of decision_01KRKEVEE3RQGPWHAPMZ0MS9G9.

export {
  getPool,
  closePool,
  withClient,
  withTransaction,
  ensureSchema,
  pingDb,
} from "./client.js";

export type { PoolClient } from "pg";

export {
  upsertEntity,
  getEntity,
  listEntitiesByDoco,
  listIdentityRows,
  resolveDocoId,
  appendAuditEventRow,
  readAuditEventRows,
  type AuditEventRow,
  // Phase 3 host + identity helpers (replace FS reads)
  getHostConfig,
  upsertHostConfig,
  getPrincipalById,
  getPrincipalByUsername,
  listPrincipals,
  listOrganizations,
  listOrganizationsForPrincipal,
  upsertOrgMember,
  isOrgMember,
  isOrgAdmin,
  listAllDocos,
  getDocoById,
  getDocoBySlug,
  resolveOwnerSlug,
  type HostConfigRow,
  type PrincipalRow,
  type OrganizationRow,
  type DocoRow,
} from "./repo.js";

export { NODE_TABLES, type EntityRecord } from "./types.js";

// Postgres is the only source-of-truth. There is no legacy filesystem
// fallback (rule_01KRKQDHWNWJAF4YKTMCB2A0D9 — alpha forbids back-compat).
