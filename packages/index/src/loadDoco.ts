// Read-side loader from Postgres (Phase 2 of decision_01KRKEVEE3RQGPWHAPMZ0MS9G9).
//
// Returns the `LoadedDoco` shape expected by the index pipeline.

import { type EntityRecord, listEntitiesByDoco, listIdentityRows, withClient } from "@doco/db";
import type {
  Doco,
  Entity,
  EntityId,
  LoadFailure,
  LoadedDoco,
  LoadedEntity,
  EntityType,
} from "@doco/shared";
import { NODE_TYPES, isEntityId } from "@doco/shared";
import { parse as parseYamlText } from "yaml";

/**
 * Parse a `raw_yaml` Postgres column into the entity shape used by the
 * indexer. The column name is historical; current writers serialize JSON,
 * and the YAML parser accepts that subset cleanly.
 */
function parseRawYaml(text: string): Record<string, unknown> {
  return parseYamlText(text) as Record<string, unknown>;
}

// Doco-scoped types (have a `doco_id` column, queryable via listEntitiesByDoco).
const SCOPED_NODE_TYPES: EntityType[] = NODE_TYPES.filter(
  (t) => t !== "doco" && t !== "principal" && t !== "organization",
) as EntityType[];

/**
 * Build a `LoadedDoco` from Postgres rows for the given doco_id.
 * Mirrors `loadDoco(root)` so the downstream `indexDoco(db, loaded)`
 * pass works without changes.
 *
 * `root` is preserved on the returned object as a passthrough — it's
 * still where the per-clone SQLite cache lives, but all entity content
 * comes from Postgres.
 */
export async function loadDocoFromPostgres(root: string, docoId: string): Promise<LoadedDoco> {
  // 1. Doco metadata.
  const docoRows = await withClient(async (c) => {
    const r = await c.query("SELECT raw_yaml FROM docos WHERE id = $1", [docoId]);
    return r.rows;
  });
  if (docoRows.length === 0) {
    throw new Error(`Doco ${docoId} not found in Postgres.`);
  }
  const docoData = parseRawYaml(String(docoRows[0].raw_yaml)) as unknown as Doco;

  // 2. Entity tables (per-type rows -> LoadedEntity records).
  const entities = new Map<EntityId, LoadedEntity>();
  const byType = new Map<EntityType, LoadedEntity[]>();
  for (const t of NODE_TYPES) byType.set(t, []);
  const failures: LoadFailure[] = [];

  // Host-level identity rows are loaded once (no doco_id filter).
  for (const t of ["principal", "organization"] as const) {
    let rows: EntityRecord[] = [];
    try {
      rows = await listIdentityRows(t);
    } catch (err) {
      failures.push({
        filePath: `<postgres>:${t}`,
        reason: `listIdentityRows(${t}) failed: ${(err as Error).message}`,
      });
      continue;
    }
    for (const row of rows) {
      const fm = parseRawYaml(row.raw_yaml);
      const id = fm.id;
      if (!isEntityId(id)) continue;
      const loaded: LoadedEntity = {
        entity: fm as unknown as Entity,
        filePath: `<postgres>:${t}/${row.id}`,
        parsed: { data: fm, body: "", format: "json" },
      };
      entities.set(id as EntityId, loaded);
      byType.get(t as EntityType)?.push(loaded);
    }
  }

  for (const t of SCOPED_NODE_TYPES) {
    let rows: EntityRecord[] = [];
    try {
      rows = await listEntitiesByDoco(t, docoId);
    } catch (err) {
      // Table may not exist yet; skip with a failure note rather than crashing.
      failures.push({
        filePath: `<postgres>:${t}`,
        reason: `listEntitiesByDoco(${t}) failed: ${(err as Error).message}`,
      });
      continue;
    }
    for (const row of rows) {
      const fm = parseRawYaml(row.raw_yaml);
      const id = fm.id;
      if (!isEntityId(id)) {
        failures.push({
          filePath: `<postgres>:${t}/${row.id}`,
          reason: "Missing or malformed 'id' field in raw_yaml",
        });
        continue;
      }
      const entity = fm as unknown as Entity;
      const loaded: LoadedEntity = {
        entity,
        filePath: `<postgres>:${t}/${row.id}`,
        parsed: {
          data: fm,
          body: row.body_md ?? "",
          format: "json",
        },
      };
      entities.set(id as EntityId, loaded);
      byType.get(t)?.push(loaded);
    }
  }

  return { root, doco: docoData, entities, byType, failures };
}
