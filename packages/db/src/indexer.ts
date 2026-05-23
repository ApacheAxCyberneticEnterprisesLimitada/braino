// Postgres-backed derived-data builder. Computes the `synapses` and FTS
// rows the indexer (@doco/index) builds, and writes them straight to
// Postgres.
//
// Pure side-effecting writer: caller supplies the entities + computed
// synapses and the doco_id; we wipe and rebuild PG-side derived rows for
// that Doco atomically.
//
// Post-migration-005 FTS shape: ONE table per top-level category
// (neurons, primitives, collaborators, docos, organizations). The
// indexer only ever populates the per-Doco categories: `entity_fts_neurons`
// and `entity_fts_primitives`. Collaborators/docos/organizations are
// host-level entities; their FTS rows are written by their own upsert
// paths (or by the migration), not by this builder.

import { withTransaction } from "./client.js";

const NEURON_TYPES = new Set([
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

const PRIMITIVE_TYPES = new Set(["guidance_primitive", "neuron_authoring_primitive"]);

function primitiveKindFor(entityType: string): "guidance" | "neuron_authoring" {
  if (entityType === "guidance_primitive") return "guidance";
  if (entityType === "neuron_authoring_primitive") return "neuron_authoring";
  throw new Error(`Not a primitive type: ${entityType}`);
}

export interface FtsRowInput {
  entity_id: string;
  entity_type: string;
  /**
   * Headline text for the FTS A-weight column. Null for migrated
   * neurons (post-PR-80): their prose lives entirely in the type-named
   * column and there's no separate headline to extract, so the entire
   * text goes into `body` instead. Non-migrated entities (principal,
   * primitives) keep the legacy summary/body split.
   */
  summary: string | null;
  body: string;
}

export interface SynapseRowInput {
  from_id: string;
  from_neuron_type: string;
  to_id: string;
  to_neuron_type: string;
  synapse_type: string;
  synapse_props?: Record<string, unknown> | undefined;
}

export interface RebuildOptions {
  /**
   * When set, scope the wipe to FTS rows / outgoing synapses for these
   * entity ids only — leaving the rest of the Doco's derived data
   * untouched. Use this for single-entity captures where rebuilding
   * the whole Doco would be wasteful.
   *
   * When unset (default), every FTS row and synapse for the Doco is
   * wiped before re-insert.
   */
  onlyEntityIds?: string[];
}

/**
 * Replace synapse and FTS rows in Postgres. Runs in a single transaction —
 * readers see the old set or the new set, never a partial mix.
 */
export async function rebuildDocoDerivedData(
  docoId: string,
  fts: FtsRowInput[],
  synapses: SynapseRowInput[],
  opts: RebuildOptions = {},
): Promise<{ ftsRows: number; synapseRows: number }> {
  const dedupedFts = dedupeFts(fts);
  const dedupedEdges = dedupeEdges(synapses);

  // Split FTS rows by category — neurons vs primitives.
  const neuronFts = dedupedFts.filter((r) => NEURON_TYPES.has(r.entity_type));
  const primitiveFts = dedupedFts.filter((r) => PRIMITIVE_TYPES.has(r.entity_type));

  return withTransaction(async (c) => {
    if (opts.onlyEntityIds && opts.onlyEntityIds.length > 0) {
      // Incremental wipe.
      await c.query("DELETE FROM synapses WHERE doco_id = $1 AND from_id = ANY($2::text[])", [
        docoId,
        opts.onlyEntityIds,
      ]);
      await c.query(
        "DELETE FROM entity_fts_neurons WHERE doco_id = $1 AND entity_id = ANY($2::text[])",
        [docoId, opts.onlyEntityIds],
      );
      await c.query(
        "DELETE FROM entity_fts_primitives WHERE doco_id = $1 AND entity_id = ANY($2::text[])",
        [docoId, opts.onlyEntityIds],
      );
    } else {
      await c.query("DELETE FROM synapses WHERE doco_id = $1", [docoId]);
      await c.query("DELETE FROM entity_fts_neurons WHERE doco_id = $1", [docoId]);
      await c.query("DELETE FROM entity_fts_primitives WHERE doco_id = $1", [docoId]);
    }

    if (neuronFts.length > 0) {
      await c.query(
        `INSERT INTO entity_fts_neurons (entity_id, doco_id, neuron_type, summary, body)
         SELECT u.entity_id, $1, u.neuron_type, u.summary, u.body
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[])
              AS u(entity_id, neuron_type, summary, body)
         ON CONFLICT (entity_id) DO UPDATE SET
              doco_id     = EXCLUDED.doco_id,
              neuron_type = EXCLUDED.neuron_type,
              summary     = EXCLUDED.summary,
              body        = EXCLUDED.body`,
        [
          docoId,
          neuronFts.map((r) => r.entity_id),
          neuronFts.map((r) => r.entity_type),
          neuronFts.map((r) => r.summary),
          neuronFts.map((r) => r.body),
        ],
      );
    }

    if (primitiveFts.length > 0) {
      await c.query(
        `INSERT INTO entity_fts_primitives (entity_id, doco_id, primitive_kind, summary, body)
         SELECT u.entity_id, $1, u.primitive_kind, u.summary, u.body
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[])
              AS u(entity_id, primitive_kind, summary, body)
         ON CONFLICT (entity_id) DO UPDATE SET
              doco_id        = EXCLUDED.doco_id,
              primitive_kind = EXCLUDED.primitive_kind,
              summary        = EXCLUDED.summary,
              body           = EXCLUDED.body`,
        [
          docoId,
          primitiveFts.map((r) => r.entity_id),
          primitiveFts.map((r) => primitiveKindFor(r.entity_type)),
          primitiveFts.map((r) => r.summary),
          primitiveFts.map((r) => r.body),
        ],
      );
    }

    if (dedupedEdges.length > 0) {
      await c.query(
        `INSERT INTO synapses (
            from_id, from_neuron_type, to_id, to_neuron_type, synapse_type,
            doco_id, synapse_props_json
         )
         SELECT u.from_id, u.from_neuron_type, u.to_id, u.to_neuron_type,
                u.synapse_type, $1, u.props::jsonb
         FROM unnest(
                $2::text[], $3::text[], $4::text[], $5::text[],
                $6::text[], $7::text[]
              ) AS u(from_id, from_neuron_type, to_id, to_neuron_type,
                     synapse_type, props)
         ON CONFLICT (from_id, to_id, synapse_type) DO UPDATE SET
            from_neuron_type   = EXCLUDED.from_neuron_type,
            to_neuron_type     = EXCLUDED.to_neuron_type,
            doco_id            = EXCLUDED.doco_id,
            synapse_props_json = EXCLUDED.synapse_props_json`,
        [
          docoId,
          dedupedEdges.map((e) => e.from_id),
          dedupedEdges.map((e) => e.from_neuron_type),
          dedupedEdges.map((e) => e.to_id),
          dedupedEdges.map((e) => e.to_neuron_type),
          dedupedEdges.map((e) => e.synapse_type),
          dedupedEdges.map((e) => (e.synapse_props ? JSON.stringify(e.synapse_props) : null)),
        ],
      );
    }

    return { ftsRows: dedupedFts.length, synapseRows: dedupedEdges.length };
  });
}

function dedupeFts(rows: FtsRowInput[]): FtsRowInput[] {
  if (rows.length < 2) return rows;
  const map = new Map<string, FtsRowInput>();
  for (const r of rows) map.set(r.entity_id, r);
  return [...map.values()];
}

function dedupeEdges(synapses: SynapseRowInput[]): SynapseRowInput[] {
  if (synapses.length < 2) return synapses;
  const map = new Map<string, SynapseRowInput>();
  for (const e of synapses) {
    map.set(`${e.from_id}|${e.to_id}|${e.synapse_type}`, e);
  }
  return [...map.values()];
}
