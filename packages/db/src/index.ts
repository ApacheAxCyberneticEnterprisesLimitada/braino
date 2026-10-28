// @doco/db — Postgres adapter for Doco source-of-truth storage.
// Phase 2 of decision_01KRKEVEE3RQGPWHAPMZ0MS9G9.

export {
  getPool,
  closePool,
  withClient,
  withTransaction,
  ensureSchema,
  applySchemaAtDeploy,
} from "./client.js";

export type { PoolClient } from "pg";

export {
  upsertNode,
  upsertPolicy,
  nodeRowFromFields,
  getEntity,
  listActiveEdgeTypesForNode,
  listNodesByCollection,
  listNodesByCollectionAndIds,
  rowToNode,
  appendAuditEventRow,
  readAuditEventRows,
  type AuditEventRow,
  // Host + identity helpers
  getHostConfig,
  // Users (the people who sign in)
  getUserById,
  getUserForSession,
  getUserByUsername,
  getUserByGithubLogin,
  getUserByEmail,
  listUsers,
  patchUserData,
  setUserName,
  setUserPublicProfile,
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
  // collection membership (decision_01KS0JBJ5X0AZ4XJJFKEWE1R62)
  type CollectionRole,
  type CollectionGrant,
  type CollectionUserRow,
  ROLE_RANK,
  roleAtLeast,
  maxRole,
  getCollectionUserRole,
  getCollectionUserGrant,
  listCollectionUsers,
  listCollectionIdsForUser,
  upsertCollectionUser,
  removeCollectionUser,
  // Access requests (decision_01KS… request/grant loop)
  type AccessRequestRow,
  createAccessRequest,
  getAccessRequest,
  listPendingAccessRequestsForCollections,
  listPendingAccessRequestsForWorkspaces,
  listPendingWorkspaceAccessRequestCounts,
  listPendingAccessRequestCountsByCollection,
  decideAccessRequest,
  cancelAccessRequest,
  // collections
  listAllCollections,
  getCollectionById,
  getCollectionByHandle,
  getCollectionByIdOrHandle,
  markCollectionDeleted,
  purgeCollectionsDeletedBefore,
  type CollectionRow,
  type HostConfigRow,
} from "./repo.js";

export {
  ALL_ENTITY_TABLES,
  COLLECTION_NODE_TABLE_BY_TYPE,
  COLLECTION_NODE_TABLE_SPECS,
  COLLECTION_GENERIC_CAPTURE_NODE_TABLE_SPECS,
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
  embeddingLiteral,
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
  exportRetrievalSnapshot,
  restoreRetrievalSnapshot,
  retrievalSnapshotDigest,
  type ExportRetrievalSnapshotOptions,
  type RestoreRetrievalSnapshotResult,
  type RetrievalSnapshot,
  type RetrievalSnapshotManifest,
  type RetrievalSnapshotTables,
  type SnapshotRow,
  type SnapshotTableName,
} from "./retrieval-snapshot.js";

export {
  rebuildCollectionDerivedData,
  type FtsRowInput,
} from "./indexer.js";

export {
  ingestRetrievalDocument,
  upsertRetrievalEmbeddings,
  normalizeRetrievalEntityName,
  searchRetrievalChunksFts,
  searchRetrievalEntitiesFts,
  searchRetrievalRelationsFts,
  listAccessibleRetrievalIds,
  rankRetrievalVectors,
  loadRetrievalRelations,
  expandRetrievalRelations,
  loadChunksMentioningEntities,
  loadRetrievalChunks,
  loadRetrievalChunkContext,
  type RetrievalChunkInput,
  type RetrievalMentionInput,
  type RetrievalEntityInput,
  type RetrievalRelationshipInput,
  type RetrievalDocumentInput,
  type RetrievalIngestReport,
  type RetrievalEmbeddingTargets,
  type RetrievalChunkRow,
  type RetrievalEntityHit,
  type RetrievalRelationRow,
  type RetrievalRelationExpansion,
} from "./retrieval-graph.js";

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
