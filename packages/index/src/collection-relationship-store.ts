import type { QueryClient } from "@doco/db";
import { generateUlid } from "@doco/shared";
import type {
  CollectionRelationshipEvidence,
  CollectionRelationshipInference,
  CollectionRelationshipType,
} from "./collection-relationship-validation.js";

export type CollectionRelationshipVerificationStatus = "inferred" | "verified";

export interface StoredCollectionRelationship extends CollectionRelationshipInference {
  id: string;
  workspaceId: string;
  verificationStatus: CollectionRelationshipVerificationStatus;
  createdAt: string;
  updatedAt: string;
}

interface CollectionRelationshipRow {
  id: string;
  workspace_id: string;
  from_collection_id: string;
  to_collection_id: string;
  relationship_type: CollectionRelationshipType;
  confidence: number;
  evidence: CollectionRelationshipEvidence[] | string;
  verification_status: CollectionRelationshipVerificationStatus;
  created_at: string | Date;
  updated_at: string | Date;
}

function parseEvidence(
  value: CollectionRelationshipRow["evidence"],
): CollectionRelationshipEvidence[] {
  return typeof value === "string"
    ? (JSON.parse(value) as CollectionRelationshipEvidence[])
    : value;
}

function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function storedRelationship(row: CollectionRelationshipRow): StoredCollectionRelationship {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    from: row.from_collection_id,
    to: row.to_collection_id,
    type: row.relationship_type,
    confidence: Number(row.confidence),
    evidence: parseEvidence(row.evidence),
    verificationStatus: row.verification_status,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

export async function replaceWorkspaceRelationships(
  c: QueryClient,
  input: {
    workspaceId: string;
    relationships: readonly CollectionRelationshipInference[];
  },
): Promise<StoredCollectionRelationship[]> {
  const endpointIds = new Set<string>();
  for (const relationship of input.relationships) {
    endpointIds.add(relationship.from);
    endpointIds.add(relationship.to);
  }

  await c.query("BEGIN");
  try {
    const collections = await c.query<{ id: string }>(
      `SELECT id
         FROM collections
        WHERE workspace_id = $1
          AND deleted_at IS NULL
        FOR UPDATE`,
      [input.workspaceId],
    );
    const liveCollectionIds = new Set(collections.rows.map((collection) => collection.id));
    if ([...endpointIds].some((id) => !liveCollectionIds.has(id))) {
      throw new Error(
        `Every relationship endpoint must be a live collection in ${input.workspaceId}`,
      );
    }

    await c.query(
      `DELETE FROM collection_relationships
        WHERE workspace_id = $1`,
      [input.workspaceId],
    );

    const stored: StoredCollectionRelationship[] = [];
    for (const relationship of input.relationships) {
      const result = await c.query<CollectionRelationshipRow>(
        `INSERT INTO collection_relationships
           (id, workspace_id, from_collection_id, to_collection_id,
            relationship_type, confidence, evidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (workspace_id, from_collection_id, relationship_type, to_collection_id)
         DO UPDATE SET
           confidence = EXCLUDED.confidence,
           evidence = EXCLUDED.evidence,
           verification_status = 'inferred',
           updated_at = now()
         RETURNING *`,
        [
          `collection_relationship_${generateUlid()}`,
          input.workspaceId,
          relationship.from,
          relationship.to,
          relationship.type,
          relationship.confidence,
          JSON.stringify(relationship.evidence),
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Collection relationship insert returned no row");
      stored.push(storedRelationship(row));
    }

    await c.query("COMMIT");
    return stored;
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  }
}

/**
 * List only relationships whose two endpoints are readable by the caller.
 * Filtering in SQL prevents a private collection from leaking through an edge.
 */
export async function listCollectionRelationships(
  c: QueryClient,
  input: { workspaceId: string; collectionIds: readonly string[] },
): Promise<StoredCollectionRelationship[]> {
  if (input.collectionIds.length === 0) return [];
  const result = await c.query<CollectionRelationshipRow>(
    `SELECT *
       FROM collection_relationships
      WHERE workspace_id = $1
        AND from_collection_id = ANY($2::text[])
        AND to_collection_id = ANY($2::text[])
      ORDER BY from_collection_id, relationship_type, to_collection_id`,
    [input.workspaceId, [...input.collectionIds]],
  );
  return result.rows.map(storedRelationship);
}
