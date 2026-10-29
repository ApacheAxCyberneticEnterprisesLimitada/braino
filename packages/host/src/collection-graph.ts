import {
  COLLECTION_EDGE_TYPES,
  type CollectionEdge,
  type CollectionEdgeType,
  generateUlid,
} from "@doco/shared";

export interface CollectionGraphClient {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

const EDGE_TYPE_SET: ReadonlySet<string> = new Set(COLLECTION_EDGE_TYPES);

function normalizeEdge(
  row: Omit<CollectionEdge, "created_at"> & { created_at: unknown },
): CollectionEdge {
  return {
    ...row,
    created_at: new Date(row.created_at as string | number | Date).toISOString(),
  };
}

/** The one writer for explicit workspace-level collection relationships. */
export async function createCollectionEdge(
  c: CollectionGraphClient,
  input: {
    workspaceId: string;
    edgeType: CollectionEdgeType;
    fromCollectionId: string;
    toCollectionId: string;
    createdBy: string | null;
  },
): Promise<{ created: boolean; edge: CollectionEdge }> {
  if (!EDGE_TYPE_SET.has(input.edgeType)) {
    throw new Error(
      `Unknown collection edge type '${input.edgeType}'. Valid: ${COLLECTION_EDGE_TYPES.join(", ")}.`,
    );
  }
  if (input.fromCollectionId === input.toCollectionId) {
    throw new Error("A collection edge must connect two different collections.");
  }
  const endpoints = await c.query<{ id: string }>(
    `SELECT id FROM collections
      WHERE workspace_id = $1 AND deleted_at IS NULL AND id = ANY($2::text[])
      ORDER BY id`,
    [input.workspaceId, [input.fromCollectionId, input.toCollectionId]],
  );
  if (endpoints.rows.length !== 2) {
    throw new Error(`Both endpoints must be live collections in ${input.workspaceId}.`);
  }

  const inserted = await c.query<Omit<CollectionEdge, "created_at"> & { created_at: unknown }>(
    `INSERT INTO collection_edges
       (id, workspace_id, edge_type, from_collection_id, to_collection_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (workspace_id, from_collection_id, to_collection_id, edge_type) DO NOTHING
     RETURNING id, workspace_id, edge_type, from_collection_id, to_collection_id,
               created_at, created_by`,
    [
      `collection_edge_${generateUlid()}`,
      input.workspaceId,
      input.edgeType,
      input.fromCollectionId,
      input.toCollectionId,
      input.createdBy,
    ],
  );
  const created = inserted.rows[0];
  if (created) return { created: true, edge: normalizeEdge(created) };

  const existing = await c.query<Omit<CollectionEdge, "created_at"> & { created_at: unknown }>(
    `SELECT id, workspace_id, edge_type, from_collection_id, to_collection_id,
            created_at, created_by
       FROM collection_edges
      WHERE workspace_id = $1 AND from_collection_id = $2
        AND to_collection_id = $3 AND edge_type = $4`,
    [input.workspaceId, input.fromCollectionId, input.toCollectionId, input.edgeType],
  );
  const edge = existing.rows[0];
  if (!edge) throw new Error("Collection edge disappeared while it was being created.");
  return { created: false, edge: normalizeEdge(edge) };
}
