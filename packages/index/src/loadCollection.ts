// Read-side loader from Postgres (Phase 2 of decision_01KRKEVEE3RQGPWHAPMZ0MS9G9).
//
// Returns the `LoadedCollection` shape expected by the index pipeline.
//
// Two modes:
//   - Full load (no `opts.entityIds`): every node in the collection (all 10 node
//     types). Used for first-build and bulk rebuilds.
//   - Scoped load (`opts.entityIds` set): only the named ids are read. The
//     incremental reindex path only consumes the entities whose ids it passed
//     in; loading the rest was pure waste.

import {
  type NodeRow,
  listNodesByCollection,
  listNodesByCollectionAndIds,
  withClient,
} from "@doco/db";
import type {
  Collection,
  Entity,
  EntityId,
  EntityType,
  LoadFailure,
  LoadedCollection,
  LoadedEntity,
} from "@doco/shared";
import { ENTITY_TYPES, NODE_TYPES, isEntityId } from "@doco/shared";
import { entityTypeFromId } from "./entity-id.js";

// All node types are collection-scoped.
const COLLECTION_SCOPED_NODE_TYPES: EntityType[] = [...NODE_TYPES] as EntityType[];

export interface LoadCollectionOptions {
  /**
   * When set, load only these specific entity ids. Grouped by id prefix so each
   * entity type only does one targeted SQL. Used by the incremental reindex
   * path — every other consumer wants the full load.
   */
  entityIds?: string[];
}

function typeFromId(id: string): string {
  return entityTypeFromId(id);
}

/**
 * Build a `LoadedCollection` from Postgres rows for the given collection_id.
 * Mirrors the old loader shape so the downstream `indexCollection(db, loaded)`
 * pass works without filesystem context. Postgres is the only source of
 * entity content.
 */
export async function loadCollectionFromPostgres(
  collectionId: string,
  opts: LoadCollectionOptions = {},
): Promise<LoadedCollection> {
  // 1. Collection metadata.
  const collectionRows = await withClient(async (c) => {
    const r = await c.query<{ data: Record<string, unknown> | null }>(
      "SELECT data FROM collections WHERE id = $1",
      [collectionId],
    );
    return r.rows;
  });
  if (collectionRows.length === 0) {
    throw new Error(`Collection ${collectionId} not found in Postgres.`);
  }
  const collectionData = (collectionRows[0].data ?? {}) as unknown as Collection;

  // 2. Entity tables (per-type rows -> LoadedEntity records).
  const entities = new Map<EntityId, LoadedEntity>();
  const byType = new Map<EntityType, LoadedEntity[]>();
  for (const t of ENTITY_TYPES) byType.set(t, []);
  const failures: LoadFailure[] = [];

  const scoped = opts.entityIds && opts.entityIds.length > 0;

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

  for (const t of COLLECTION_SCOPED_NODE_TYPES) {
    let rows: NodeRow[] = [];
    try {
      if (scoped) {
        const ids = idsByType.get(t);
        if (!ids || ids.length === 0) continue;
        rows = await listNodesByCollectionAndIds(t, collectionId, ids);
      } else {
        rows = await listNodesByCollection(t, collectionId);
      }
    } catch (err) {
      // Table may not exist yet; skip with a failure note rather than crashing.
      failures.push({
        filePath: `<postgres>:${t}`,
        reason: `listNodesByCollection(${t}) failed: ${(err as Error).message}`,
      });
      continue;
    }
    for (const rec of rows) {
      if (!isEntityId(rec.id)) {
        failures.push({
          filePath: `<postgres>:${t}/${rec.id}`,
          reason: "Missing or malformed 'id'",
        });
        continue;
      }
      // The honest node row, flattened for the index's search-text needs:
      // `prose` rides in `prose`; the domain fields (`extra` + the
      // promoted scalars) are the fallback index text.
      const data: Record<string, unknown> = {
        ...rec.extra,
        ...(rec.kind != null ? { kind: rec.kind } : {}),
        ...(rec.locator != null ? { locator: rec.locator } : {}),
      };
      const entity = {
        id: rec.id,
        collection_id: rec.collection_id,
        node_type: rec.node_type,
        prose: rec.prose,
        ...data,
      } as unknown as Entity;
      const loaded: LoadedEntity = {
        entity,
        filePath: `<postgres>:${t}/${rec.id}`,
        parsed: {
          data,
          format: "postgres",
          prose: rec.prose || null,
        },
      };
      entities.set(rec.id as EntityId, loaded);
      byType.get(t)?.push(loaded);
    }
  }

  return { collection: collectionData, entities, byType, failures };
}
