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
  resolveDocoIdByHandle,
  appendAuditEventRow,
  readAuditEventRows,
  type AuditEventRow,
  // Host + identity helpers
  getHostConfig,
  upsertHostConfig,
  getPrincipalById,
  getPrincipalByUsername,
  listPrincipals,
  listOrganizations,
  listOrganizationsForPrincipal,
  upsertOrgUser,
  removeOrgUser,
  isOrgUser,
  isOrgAdmin,
  getOrgRole,
  // Doco / scope membership (decision_01KS0JBJ5X0AZ4XJJFKEWE1R62)
  type DocoRole,
  type DocoUserRow,
  type ScopeUserRow,
  ROLE_RANK,
  roleAtLeast,
  maxRole,
  getDocoUserRole,
  listDocoUsers,
  listDocoIdsForUserPrincipal,
  upsertDocoUser,
  removeDocoUser,
  getScopeUserRole,
  listScopeUsers,
  listScopeIdsWithGrant,
  listScopeIdsForUserPrincipal,
  upsertScopeUser,
  removeScopeUser,
  listAllDocos,
  getDocoById,
  getDocoByHandle,
  getDocoByIdOrHandle,
  resolveOwnerSlug,
  type HostConfigRow,
  type PrincipalRow,
  type OrganizationRow,
  type DocoRow,
} from "./repo.js";

export { NODE_TABLES, type EntityRecord } from "./types.js";

export {
  upsertEmbeddings,
  getEmbeddings,
  getAllEmbeddingsForDoco,
  computeContentHash,
  cosineSimilarity,
  embeddingToBuffer,
  bufferToEmbedding,
  type EmbeddingProviderLike,
  type EmbeddingsReport,
  type UpsertEmbeddingsOptions,
  type EmbeddingInput,
} from "./embeddings.js";

export {
  rebuildDocoDerivedData,
  type FtsRowInput,
  type EdgeRowInput,
} from "./indexer.js";

// Postgres is the only source-of-truth. There is no legacy filesystem
// fallback (rule_01KRKQDHWNWJAF4YKTMCB2A0D9 — alpha forbids back-compat).
