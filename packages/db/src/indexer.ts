// Postgres-backed FTS row builder. Computes the full-text-search rows
// the indexer (@doco/index) builds and writes them straight to Postgres.
//
// Pure side-effecting writer: caller supplies the entities' FTS rows and
// the doco_id; we wipe and rebuild the PG-side FTS rows for that Doco
// atomically. Edges are FIRST-CLASS (doco-vnext) — authored via commit()
// + edge CRUD (see vnext.ts), never derived, wiped, or rebuilt here.
//
// FTS shape: one table per Doco-scoped category — `entity_fts_nodes`
// and `entity_fts_policies` — both populated here. (Users, docos, and
// organizations are host-level and were never indexed; their unused
// entity_fts_* tables were dropped in migration 071.)

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

const POLICY_TYPES = new Set(["guidance_policy", "node_authoring_policy"]);

function policyKindFor(entityType: string): "guidance" | "node_authoring" {
  if (entityType === "guidance_policy") return "guidance";
  if (entityType === "node_authoring_policy") return "node_authoring";
  throw new Error(`Not a policy type: ${entityType}`);
}

export interface FtsRowInput {
  entity_id: string;
  entity_type: string;
  /**
   * Headline text for the FTS A-weight column. Null for migrated
   * nodes (post-PR-80): their prose lives entirely in the type-named
   * column and there's no separate headline to extract, so the entire
   * text goes into `body` instead. Non-migrated entities (principal,
   * policies) keep the legacy summary/body split.
   */
  summary: string | null;
  body: string;
}

export interface RebuildOptions {
  /**
   * When set, scope the wipe to FTS rows / outgoing edges for these
   * entity ids only — leaving the rest of the Doco's derived data
   * untouched. Use this for single-entity captures where rebuilding
   * the whole Doco would be wasteful.
   *
   * When unset (default), every FTS row and edge for the Doco is
   * wiped before re-insert.
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

  // Split FTS rows by category — nodes vs policies.
  const nodeFts = dedupedFts.filter((r) => NODE_TYPES.has(r.entity_type));
  const policyFts = dedupedFts.filter((r) => POLICY_TYPES.has(r.entity_type));

  return withTransaction(async (c) => {
    if (opts.onlyEntityIds && opts.onlyEntityIds.length > 0) {
      // Incremental wipe — FTS rows for these entity ids only.
      await c.query(
        "DELETE FROM entity_fts_nodes WHERE doco_id = $1 AND entity_id = ANY($2::text[])",
        [docoId, opts.onlyEntityIds],
      );
      await c.query(
        "DELETE FROM entity_fts_policies WHERE doco_id = $1 AND entity_id = ANY($2::text[])",
        [docoId, opts.onlyEntityIds],
      );
    } else {
      await c.query("DELETE FROM entity_fts_nodes WHERE doco_id = $1", [docoId]);
      await c.query("DELETE FROM entity_fts_policies WHERE doco_id = $1", [docoId]);
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

    if (policyFts.length > 0) {
      await c.query(
        // The `policy` column on entity_fts_policies was renamed from
        // `summary` in migration 038 to match the source policy
        // tables. The indexer's column-as-text source is still the
        // FtsRow.summary field — kept as-is to avoid rippling the
        // rename through every callsite that builds these rows.
        `INSERT INTO entity_fts_policies (entity_id, doco_id, policy_kind, policy, body)
         SELECT u.entity_id, $1, u.policy_kind, u.policy_text, u.body
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[])
              AS u(entity_id, policy_kind, policy_text, body)
         ON CONFLICT (entity_id) DO UPDATE SET
              doco_id     = EXCLUDED.doco_id,
              policy_kind = EXCLUDED.policy_kind,
              policy      = EXCLUDED.policy,
              body        = EXCLUDED.body`,
        [
          docoId,
          policyFts.map((r) => r.entity_id),
          policyFts.map((r) => policyKindFor(r.entity_type)),
          policyFts.map((r) => r.summary),
          policyFts.map((r) => r.body),
        ],
      );
    }

    return { ftsRows: dedupedFts.length };
  });
}

function dedupeFts(rows: FtsRowInput[]): FtsRowInput[] {
  if (rows.length < 2) return rows;
  const map = new Map<string, FtsRowInput>();
  for (const r of rows) map.set(r.entity_id, r);
  return [...map.values()];
}
