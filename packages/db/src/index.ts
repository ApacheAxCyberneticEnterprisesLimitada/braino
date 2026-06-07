// @doco/db — Postgres adapter for Doco source-of-truth storage.
// Phase 2 of decision_01KRKEVEE3RQGPWHAPMZ0MS9G9.

export {
  getPool,
  closePool,
  withClient,
  withTransaction,
  ensureSchema,
} from "./client.js";

export type { PoolClient } from "pg";

export {
  upsertNode,
  upsertPolicy,
  nodeRowFromFields,
  getEntity,
  listEntitiesByDoco,
  listEntitiesByDocoAndIds,
  rowToNode,
  appendAuditEventRow,
  readAuditEventRows,
  type AuditEventRow,
  // Host + identity helpers
  getHostConfig,
  // Users (human OAuth identity layer)
  getUserById,
  getUserByGithubLogin,
  listUsers,
  patchUserData,
  type UserRow,
  // Principals (role-personas — node type)
  getPrincipalById,
  listPrincipals,
  // Workspaces
  listWorkspaces,
  getWorkspaceById,
  listWorkspacesForUser,
  upsertWorkspaceUser,
  removeWorkspaceUser,
  isWorkspaceUser,
  getWorkspaceRole,
  getWorkspaceGrant,
  listWorkspaceOwnerUserIds,
  // Account-level grants
  type AccountGrantRow,
  getAccountGrant,
  upsertAccountGrant,
  removeAccountGrant,
  getWorkspaceConstitutionsByIds,
  updateWorkspaceConstitution,
  type WorkspaceRow,
  type WorkspaceConstitution,
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
  // Access requests (decision_01KS… request/grant loop)
  type AccessRequestRow,
  createAccessRequest,
  getAccessRequest,
  listPendingAccessRequestsForDocos,
  listPendingAccessRequestCountsByDoco,
  decideAccessRequest,
  cancelAccessRequest,
  // Docos
  listAllDocos,
  getDocoById,
  getDocoByHandle,
  getDocoByIdOrHandle,
  type DocoRow,
  type HostConfigRow,
} from "./repo.js";

export {
  ALL_ENTITY_TABLES,
  DOCO_NODE_TABLE_BY_TYPE,
  DOCO_NODE_TABLE_SPECS,
  DOCO_GENERIC_CAPTURE_NODE_TABLE_SPECS,
  NODE_TABLES,
  USER_TABLES,
  CONTAINER_TABLES,
  type NodeRow,
  type PolicyWrite,
  type EntityTableSpec,
} from "./types.js";

export {
  upsertEmbeddings,
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
} from "./indexer.js";

// Append-only write runtime: commit boundary + first-class edge CRUD +
// immutable version snapshots + as-of reads.
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
} from "./history.js";

// Postgres is the only source-of-truth.
