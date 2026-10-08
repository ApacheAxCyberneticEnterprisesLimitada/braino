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
  listNodesByDoco,
  listNodesByDocoAndIds,
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
  getWorkspaceRole,
  getWorkspaceGrant,
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
  markDocoDeleted,
  purgeDocosDeletedBefore,
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
  EMBEDDING_BATCH,
  EMBEDDING_DIMENSIONS,
  deleteEmbeddings,
  rankEmbeddings,
  upsertEmbeddings,
  vectorLiteral,
  type EmbeddingHit,
  type EmbeddingInput,
  type EmbeddingProviderLike,
  type EmbeddingSource,
  type EmbeddingsReport,
  type QueryClient,
  type SemanticQuery,
  type UpsertEmbeddingsOptions,
} from "./embeddings.js";
export { CHUNK_CHARS, CHUNK_OVERLAP_CHARS, chunkText, nodeIndexText } from "./chunks.js";

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
  retireActiveEdgesForNode,
  EDGE_ENDPOINTS_NOT_ACTIVE,
  getVersions,
  verifyHistory,
  entityAsOf,
  type CommitInput,
  type CommitSource,
  type CreateEdgeInput,
  type EdgeRow,
} from "./history.js";

// Postgres is the only source-of-truth.
