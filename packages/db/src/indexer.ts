// Postgres-backed derived-data builder. Computes the same `edges` and
// `entity_fts` rows the SQLite indexer (@doco/index) builds, but writes
// them straight to Postgres. Part of the SQLite-removal migration that
// supersedes ADR-023 / ADR-024.
//
// Pure side-effecting writer: caller supplies the entities + computed
// edges (we keep edge derivation in @doco/index where the shared logic
// already lives) and the doco_id; we wipe and rebuild PG-side derived
// rows for that doco atomically.

import { withTransaction } from "./client.js";

export interface FtsRowInput {
  entity_id: string;
  node_type: string;
  summary: string;
  body: string;
}

export interface EdgeRowInput {
  from_id: string;
  from_node_type: string;
  to_id: string;
  to_node_type: string;
  edge_type: string;
  edge_props?: Record<string, unknown> | undefined;
  attribution?: "explicit" | "doco-auto" | undefined;
}

/**
 * Replace every edge and entity_fts row for one Doco. Runs in a single
 * transaction — readers see the old set or the new set, never a
 * partial mix.
 */
export async function rebuildDocoDerivedData(
  docoId: string,
  fts: FtsRowInput[],
  edges: EdgeRowInput[],
): Promise<{ ftsRows: number; edgeRows: number }> {
  return withTransaction(async (c) => {
    await c.query("DELETE FROM edges WHERE doco_id = $1", [docoId]);
    await c.query("DELETE FROM entity_fts WHERE doco_id = $1", [docoId]);

    for (const row of fts) {
      await c.query(
        `INSERT INTO entity_fts (entity_id, doco_id, node_type, summary, body)
              VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (entity_id) DO UPDATE SET
              doco_id   = EXCLUDED.doco_id,
              node_type = EXCLUDED.node_type,
              summary   = EXCLUDED.summary,
              body      = EXCLUDED.body`,
        [row.entity_id, docoId, row.node_type, row.summary, row.body],
      );
    }

    for (const e of edges) {
      await c.query(
        `INSERT INTO edges (
            from_id, from_node_type, to_id, to_node_type, edge_type,
            doco_id, edge_props_json, attribution
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         ON CONFLICT (from_id, to_id, edge_type) DO UPDATE SET
            from_node_type  = EXCLUDED.from_node_type,
            to_node_type    = EXCLUDED.to_node_type,
            doco_id         = EXCLUDED.doco_id,
            edge_props_json = EXCLUDED.edge_props_json,
            attribution     = EXCLUDED.attribution`,
        [
          e.from_id,
          e.from_node_type,
          e.to_id,
          e.to_node_type,
          e.edge_type,
          docoId,
          e.edge_props ? JSON.stringify(e.edge_props) : null,
          e.attribution ?? "explicit",
        ],
      );
    }

    return { ftsRows: fts.length, edgeRows: edges.length };
  });
}
