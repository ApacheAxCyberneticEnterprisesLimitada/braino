/** The small, canonical vocabulary for directed relationships between collections. */
export const COLLECTION_EDGE_TYPES = [
  "implements",
  "documents",
  "depends_on",
  "derived_from",
] as const;

export type CollectionEdgeType = (typeof COLLECTION_EDGE_TYPES)[number];

export interface CollectionEdge {
  id: string;
  workspace_id: string;
  edge_type: CollectionEdgeType;
  from_collection_id: string;
  to_collection_id: string;
  created_at: string;
  created_by: string | null;
}

export type CollectionRelationshipDirection = "from_new" | "to_new";

/** An optional first relationship declared while a collection is created. */
export interface CollectionCreationRelationship {
  edgeType: CollectionEdgeType;
  relatedCollectionId: string;
  /** `from_new`: new → existing. `to_new`: existing → new. */
  direction: CollectionRelationshipDirection;
}
