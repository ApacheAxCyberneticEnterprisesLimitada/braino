// Read-side loader from Postgres (Phase 2 of decision_01KRKEVEE3RQGPWHAPMZ0MS9G9).
//
// Returns the `LoadedDoco` shape expected by the index pipeline.
//
// Two modes:
//   - Full load (no `opts.entityIds`): every entity in the Doco (all 10
//     neuron types are Doco-scoped post-migration 020), plus the host's
//     organizations. Used for first-build and bulk rebuilds.
//   - Scoped load (`opts.entityIds` set): only the named ids are read from
//     their own tables, and host-wide organization rows are skipped
//     entirely. The incremental reindex path only consumes the entities
//     whose ids it passed in; loading the rest was pure waste.

import {
  type EntityRecord,
  listEntitiesByDoco,
  listEntitiesByDocoAndIds,
  listIdentityRows,
  withClient,
} from "@doco/db";
import type {
  Doco,
  Entity,
  EntityId,
  EntityType,
  LoadFailure,
  LoadedDoco,
  LoadedEntity,
} from "@doco/shared";
import { ENTITY_TYPES, NEURON_TYPES, isEntityId } from "@doco/shared";

// All neuron types are Doco-scoped (migration 020 finished the job
// for Principals).
const DOCO_SCOPED_NEURON_TYPES: EntityType[] = [...NEURON_TYPES] as EntityType[];

export interface LoadDocoOptions {
  /**
   * When set, load only these specific entity ids (and skip host-wide
   * principal/organization rows). Grouped by id prefix so each entity
   * type only does one targeted SQL. Used by the incremental reindex
   * path — every other consumer wants the full load.
   */
  entityIds?: string[];
}

function typeFromId(id: string): string {
  return id.split("_").slice(0, -1).join("_");
}

/**
 * Build a `LoadedDoco` from Postgres rows for the given doco_id.
 * Mirrors `loadDoco(root)` so the downstream `indexDoco(db, loaded)`
 * pass works without changes.
 *
 * `root` is preserved on the returned object as a passthrough — it's
 * still where the per-clone SQLite cache lives, but all entity content
 * comes from Postgres.
 */
export async function loadDocoFromPostgres(
  root: string,
  docoId: string,
  opts: LoadDocoOptions = {},
): Promise<LoadedDoco> {
  // 1. Doco metadata.
  const docoRows = await withClient(async (c) => {
    const r = await c.query<{ data: Record<string, unknown> | null }>(
      "SELECT data FROM docos WHERE id = $1",
      [docoId],
    );
    return r.rows;
  });
  if (docoRows.length === 0) {
    throw new Error(`Doco ${docoId} not found in Postgres.`);
  }
  const docoData = (docoRows[0].data ?? {}) as unknown as Doco;

  // 2. Entity tables (per-type rows -> LoadedEntity records).
  const entities = new Map<EntityId, LoadedEntity>();
  const byType = new Map<EntityType, LoadedEntity[]>();
  for (const t of ENTITY_TYPES) byType.set(t, []);
  const failures: LoadFailure[] = [];

  const scoped = opts.entityIds && opts.entityIds.length > 0;

  // Host-level identity rows are loaded once (no doco_id filter). Only
  // needed by the full-rebuild path; incremental captures don't consume
  // them (deriveSynapses works off the entity alone, and the indexer's
  // FTS/embedding writers don't need org text). Principals moved to
  // the doco-scoped loop below in migration 020.
  if (!scoped) {
    let rows: EntityRecord[] = [];
    try {
      rows = await listIdentityRows("organization");
    } catch (err) {
      failures.push({
        filePath: "<postgres>:organization",
        reason: `listIdentityRows(organization) failed: ${(err as Error).message}`,
      });
      rows = [];
    }
    for (const row of rows) {
      const fm = row.data ?? {};
      const id = fm.id;
      if (!isEntityId(id)) continue;
      const loaded: LoadedEntity = {
        entity: fm as unknown as Entity,
        filePath: `<postgres>:organization/${row.id}`,
        parsed: { data: fm, body: "", format: "postgres" },
      };
      entities.set(id as EntityId, loaded);
      byType.get("organization" as EntityType)?.push(loaded);
    }
  }

  // Group the requested ids by their type prefix so each type gets at
  // most one query — most captures touch one entity, so this is one SQL
  // round trip total instead of one-per-type.
  const idsByType = new Map<string, string[]>();
  if (scoped) {
    for (const id of opts.entityIds ?? []) {
      const t = typeFromId(id);
      const bucket = idsByType.get(t) ?? [];
      bucket.push(id);
      idsByType.set(t, bucket);
    }
  }

  for (const t of DOCO_SCOPED_NEURON_TYPES) {
    let rows: EntityRecord[] = [];
    try {
      if (scoped) {
        const ids = idsByType.get(t);
        if (!ids || ids.length === 0) continue;
        rows = await listEntitiesByDocoAndIds(t, docoId, ids);
      } else {
        rows = await listEntitiesByDoco(t, docoId);
      }
    } catch (err) {
      // Table may not exist yet; skip with a failure note rather than crashing.
      failures.push({
        filePath: `<postgres>:${t}`,
        reason: `listEntitiesByDoco(${t}) failed: ${(err as Error).message}`,
      });
      continue;
    }
    for (const row of rows) {
      const fm = row.data ?? {};
      const id = fm.id;
      if (!isEntityId(id)) {
        failures.push({
          filePath: `<postgres>:${t}/${row.id}`,
          reason: "Missing or malformed 'id' field in data",
        });
        continue;
      }
      const entity = fm as unknown as Entity;
      // Migration-022/023: migrated neurons store their full prose in a
      // type-named column (intents.intent, decisions.decision, ...);
      // `rowToRecord` hoists that onto `row.type_named_value`. Carry it
      // through `parsed` so the indexer can route it to the FTS body /
      // embedding text without re-reading the row. Principal + other
      // non-migrated entities leave this null and keep using body_md.
      const loaded: LoadedEntity = {
        entity,
        filePath: `<postgres>:${t}/${row.id}`,
        parsed: {
          data: fm,
          body: row.body_md ?? "",
          format: "postgres",
          typeNamedValue: row.type_named_value ?? null,
        },
      };
      entities.set(id as EntityId, loaded);
      byType.get(t)?.push(loaded);
    }
  }

  return { root, doco: docoData, entities, byType, failures };
}
