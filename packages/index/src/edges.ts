import type { Entity } from "@doco/shared";

export interface Edge {
  from_id: string;
  from_node_type: string;
  to_id: string;
  to_node_type: string;
  edge_type: string;
  edge_props?: Record<string, unknown>;
}

/**
 * Node JSON no longer produces graph relationships. The edge table is the
 * single source for graph links; callers that need relationships should query
 * or write first-class edges directly.
 */
export function deriveEdges(_entity: Entity): Edge[] {
  return [];
}
