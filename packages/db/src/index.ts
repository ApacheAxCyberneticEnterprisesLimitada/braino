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
  listEntitiesByDocoAndIds,
  listIdentityRows,
  resolveDocoIdByHandle,
  appendAuditEventRow,
  readAuditEventRows,
  type AuditEventRow,
  // Host + identity helpers
  getHostConfig,
  upsertHostConfig,
  // Users (OAuth identity layer — new in migration 005)
  getUserById,
  getUserByGithubLogin,
  listUsers,
  patchUserData,
  type UserRow,
  // Principals (role-personas — node type)
  getPrincipalById,
  getPrincipalByName,
  listPrincipals,
  type PrincipalRow,
  // Organizations
  listOrganizations,
  listOrganizationsForUser,
  upsertOrgUser,
  removeOrgUser,
  isOrgUser,
  isOrgAdmin,
  getOrgRole,
  getOrgGrant,
  type OrganizationRow,
  // Doco membership (decision_01KS0JBJ5X0AZ4XJJFKEWE1R62)
  type DocoRole,
  type DocoGrant,
  type DocoUserRow,
  ROLE_RANK,
  roleAtLeast,
  maxRole,
  getDocoUserRole,
  getDocoUserGrant,
  listDocoUsers,
  listDocoIdsForUser,
  upsertDocoUser,
  removeDocoUser,
  // Docos
  listAllDocos,
  getDocoById,
  getDocoByHandle,
  getDocoByIdOrHandle,
  resolveOwnerSlug,
  type DocoRow,
  type HostConfigRow,
} from "./repo.js";

export {
  ALL_ENTITY_TABLES,
  DOCO_NODE_TABLE_BY_TYPE,
  DOCO_NODE_TABLE_SPECS,
  NODE_TABLES,
  POLICY_TABLES,
  USER_TABLES,
  CONTAINER_TABLES,
  type EntityRecord,
  type EntityTableSpec,
} from "./types.js";

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

// Append-only write runtime (doco-vnext): commit boundary + first-class
// edge CRUD + immutable version snapshots + as-of reads.
export {
  createChangeset,
  recordEntityVersion,
  appendNodeVersion,
  appendEdgeVersion,
  createEdge,
  updateEdge,
  retireEdge,
  getVersions,
  verifyHistory,
  entityAsOf,
  type CommitInput,
  type CommitSource,
  type CreateEdgeInput,
  type EdgeRow,
} from "./vnext.js";

// Postgres is the only source-of-truth. There is no legacy filesystem
// fallback (rule_01KRKQDHWNWJAF4YKTMCB2A0D9 — alpha forbids back-compat).
