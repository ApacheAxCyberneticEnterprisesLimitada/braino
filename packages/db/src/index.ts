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
  // Collaborators (OAuth identity layer — new in migration 005)
  getCollaboratorById,
  getCollaboratorByGithubLogin,
  listCollaborators,
  type CollaboratorRow,
  // Principals (role-personas — neuron type)
  getPrincipalById,
  getPrincipalByUsername,
  listPrincipals,
  type PrincipalRow,
  // Organizations
  listOrganizations,
  listOrganizationsForCollaborator,
  upsertOrgUser,
  removeOrgUser,
  isOrgUser,
  isOrgAdmin,
  getOrgRole,
  type OrganizationRow,
  // Doco membership (decision_01KS0JBJ5X0AZ4XJJFKEWE1R62)
  type DocoRole,
  type DocoUserRow,
  ROLE_RANK,
  roleAtLeast,
  maxRole,
  getDocoUserRole,
  listDocoUsers,
  listDocoIdsForCollaborator,
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
  DOCO_NEURON_TABLE_BY_TYPE,
  DOCO_NEURON_TABLE_SPECS,
  NEURON_TABLES,
  PRIMITIVE_TABLES,
  COLLABORATOR_TABLES,
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
  type SynapseRowInput,
} from "./indexer.js";

// Postgres is the only source-of-truth. There is no legacy filesystem
// fallback (rule_01KRKQDHWNWJAF4YKTMCB2A0D9 — alpha forbids back-compat).
