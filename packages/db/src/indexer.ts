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

export interface RebuildOptions {
  /**
   * When set, scope the wipe to FTS rows / outgoing edges for these
   * entity ids only — leaving the rest of the Doco's derived data
   * untouched. Use this for single-entity captures where rebuilding
   * the whole Doco would be wasteful.
   *
   * When unset (default), every FTS row and edge for the Doco is
   * wiped before re-insert — the right move for first build, bulk
   * import, or operations that touch many entities at once.
   */
  onlyEntityIds?: string[];
}

/**
 * Replace edge and entity_fts rows in Postgres. Runs in a single
 * transaction — readers see the old set or the new set, never a
 * partial mix.
 *
 * Full rebuild (no `onlyEntityIds`): wipes every derived row for the
 * Doco and reinserts. Incremental (`onlyEntityIds` set): wipes only
 * FTS rows + outgoing edges for the named entities and reinserts those.
 * Caller must pre-filter `fts` / `edges` to match the scope.
 */
export async function rebuildDocoDerivedData(
  docoId: string,
  fts: FtsRowInput[],
  edges: EdgeRowInput[],
  opts: RebuildOptions = {},
): Promise<{ ftsRows: number; edgeRows: number }> {
  // Dedupe by primary key — pg rejects "command cannot affect row a
  // second time" when one INSERT statement tries to upsert the same
  // key twice. Row-by-row INSERTs were tolerant of this; batched
  // INSERTs are not. The dedupe is cheap and the right last-write-wins
  // semantics for both shapes.
  const dedupedFts = dedupeFts(fts);
  const dedupedEdges = dedupeEdges(edges);

  return withTransaction(async (c) => {
    if (opts.onlyEntityIds && opts.onlyEntityIds.length > 0) {
      // Incremental: only wipe rows for the named entities. Outgoing
      // edges live under `from_id`; inbound edges from OTHER entities
      // (their `from_id` is unchanged) are left in place.
      await c.query(
        "DELETE FROM edges WHERE doco_id = $1 AND from_id = ANY($2::text[])",
        [docoId, opts.onlyEntityIds],
      );
      await c.query(
        "DELETE FROM entity_fts WHERE doco_id = $1 AND entity_id = ANY($2::text[])",
        [docoId, opts.onlyEntityIds],
      );
    } else {
      await c.query("DELETE FROM edges WHERE doco_id = $1", [docoId]);
      await c.query("DELETE FROM entity_fts WHERE doco_id = $1", [docoId]);
    }

    if (dedupedFts.length > 0) {
      await c.query(
        `INSERT INTO entity_fts (entity_id, doco_id, node_type, summary, body)
         SELECT u.entity_id, $1, u.node_type, u.summary, u.body
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[])
              AS u(entity_id, node_type, summary, body)
         ON CONFLICT (entity_id) DO UPDATE SET
              doco_id   = EXCLUDED.doco_id,
              node_type = EXCLUDED.node_type,
              summary   = EXCLUDED.summary,
              body      = EXCLUDED.body`,
        [
          docoId,
          dedupedFts.map((r) => r.entity_id),
          dedupedFts.map((r) => r.node_type),
          dedupedFts.map((r) => r.summary),
          dedupedFts.map((r) => r.body),
        ],
      );
    }

    if (dedupedEdges.length > 0) {
      await c.query(
        `INSERT INTO edges (
            from_id, from_node_type, to_id, to_node_type, edge_type,
            doco_id, edge_props_json, attribution
         )
         SELECT u.from_id, u.from_node_type, u.to_id, u.to_node_type,
                u.edge_type, $1, u.props::jsonb, u.attribution
         FROM unnest(
                $2::text[], $3::text[], $4::text[], $5::text[],
                $6::text[], $7::text[], $8::text[]
              ) AS u(from_id, from_node_type, to_id, to_node_type,
                     edge_type, props, attribution)
         ON CONFLICT (from_id, to_id, edge_type) DO UPDATE SET
            from_node_type  = EXCLUDED.from_node_type,
            to_node_type    = EXCLUDED.to_node_type,
            doco_id         = EXCLUDED.doco_id,
            edge_props_json = EXCLUDED.edge_props_json,
            attribution     = EXCLUDED.attribution`,
        [
          docoId,
          dedupedEdges.map((e) => e.from_id),
          dedupedEdges.map((e) => e.from_node_type),
          dedupedEdges.map((e) => e.to_id),
          dedupedEdges.map((e) => e.to_node_type),
          dedupedEdges.map((e) => e.edge_type),
          dedupedEdges.map((e) => (e.edge_props ? JSON.stringify(e.edge_props) : null)),
          dedupedEdges.map((e) => e.attribution ?? "explicit"),
        ],
      );
    }

    return { ftsRows: dedupedFts.length, edgeRows: dedupedEdges.length };
  });
}

function dedupeFts(rows: FtsRowInput[]): FtsRowInput[] {
  if (rows.length < 2) return rows;
  const map = new Map<string, FtsRowInput>();
  for (const r of rows) map.set(r.entity_id, r);
  return [...map.values()];
}

function dedupeEdges(edges: EdgeRowInput[]): EdgeRowInput[] {
  if (edges.length < 2) return edges;
  const map = new Map<string, EdgeRowInput>();
  for (const e of edges) {
    map.set(`${e.from_id}|${e.to_id}|${e.edge_type}`, e);
  }
  return [...map.values()];
}
