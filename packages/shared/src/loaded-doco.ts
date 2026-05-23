// Types for a loaded Doco — used by both the Postgres loader
// (@doco/index/loadDoco) and the validator (@doco/shared/validate).

import type { EntityId, EntityType } from "./branded.js";
import type { Doco, Entity } from "./entities.js";

export type LoadedEntitySourceFormat = "postgres";

export interface LoadedEntityParsed {
  data: Record<string, unknown>;
  body: string;
  format?: LoadedEntitySourceFormat;
  /**
   * Migration-022 type-named column value (e.g. `intents.intent`,
   * `decisions.decision`). Populated for the 9 migrated neuron types
   * whose tables expose a `typeNamedColumn` in `ALL_ENTITY_TABLES`;
   * null/undefined for principal, primitives, and other non-migrated
   * entities. The indexer reads this for FTS body + embedding text.
   */
  typeNamedValue?: string | null;
}

/** A loaded entity plus the source identifier that produced it. */
export interface LoadedEntity {
  entity: Entity;
  filePath: string;
  parsed: LoadedEntityParsed;
}

export interface LoadFailure {
  filePath: string;
  reason: string;
}

export interface LoadedDoco {
  root: string;
  doco: Doco;
  entities: Map<EntityId, LoadedEntity>;
  byType: Map<EntityType, LoadedEntity[]>;
  failures: LoadFailure[];
}
