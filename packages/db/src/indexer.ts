// Postgres-backed FTS row builder. Computes the full-text-search rows
// the indexer (@doco/index) builds and writes them straight to Postgres.
//
// Pure side-effecting writer: caller supplies the entities' FTS rows and
// the doco_id; we wipe and rebuild the PG-side FTS rows for that Doco
// atomically. Edges are first-class rows authored via commit() + edge CRUD
// (see history.ts), never derived, wiped, or rebuilt here.
//
// FTS shape: the indexer populates a single table, `entity_fts_nodes`.
// Only node FTS is built and queried.

import { withTransaction } from "./client.js";

const NODE_TYPES = new Set([
  "intent",
  "idea",
  "rule",
  "decision",
  "action",
  "log",
  "eval",
  "reference",
  "state",
  "principal",
]);

export interface FtsRowInput {
  entity_id: string;
  entity_type: string;
  /**
   * Headline text for the FTS A-weight column. Null when the full prose
   * should be indexed as body text.
   */
  summary: string | null;
  body: string;
}

export interface RebuildOptions {
  /**
   * When set, scope the wipe to FTS rows for these entity ids only —
   * leaving the rest of the Doco's derived data untouched. Use this for
   * single-entity captures where rebuilding the whole Doco would be wasteful.
   *
   * When unset (default), every FTS row for the Doco is wiped before re-insert.
   */
  onlyEntityIds?: string[];
}

/**
 * Replace the FTS rows in Postgres. Runs in a single transaction —
 * readers see the old set or the new set, never a partial mix.
 */
export async function rebuildDocoDerivedData(
  docoId: string,
  fts: FtsRowInput[],
  opts: RebuildOptions = {},
): Promise<{ ftsRows: number }> {
  const dedupedFts = dedupeFts(fts);

  // Only nodes are indexed for FTS.
  const nodeFts = dedupedFts.filter((r) => NODE_TYPES.has(r.entity_type));

  return withTransaction(async (c) => {
    if (opts.onlyEntityIds && opts.onlyEntityIds.length > 0) {
      // Incremental wipe — FTS rows for these entity ids only.
      await c.query(
        "DELETE FROM entity_fts_nodes WHERE doco_id = $1 AND entity_id = ANY($2::text[])",
        [docoId, opts.onlyEntityIds],
      );
    } else {
      await c.query("DELETE FROM entity_fts_nodes WHERE doco_id = $1", [docoId]);
    }

    if (nodeFts.length > 0) {
      await c.query(
        `INSERT INTO entity_fts_nodes (entity_id, doco_id, node_type, summary, body)
         SELECT u.entity_id, $1, u.node_type, u.summary, u.body
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[])
              AS u(entity_id, node_type, summary, body)
         ON CONFLICT (entity_id) DO UPDATE SET
              doco_id     = EXCLUDED.doco_id,
              node_type = EXCLUDED.node_type,
              summary     = EXCLUDED.summary,
              body        = EXCLUDED.body`,
        [
          docoId,
          nodeFts.map((r) => r.entity_id),
          nodeFts.map((r) => r.entity_type),
          nodeFts.map((r) => r.summary),
          nodeFts.map((r) => r.body),
        ],
      );
    }

    return { ftsRows: nodeFts.length };
  });
}

function dedupeFts(rows: FtsRowInput[]): FtsRowInput[] {
  if (rows.length < 2) return rows;
  const map = new Map<string, FtsRowInput>();
  for (const r of rows) map.set(r.entity_id, r);
  return [...map.values()];
}
