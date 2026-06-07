// Types for a loaded Doco — produced by the Postgres loader
// (@doco/index/loadDoco).

import type { EntityId, EntityType } from "./branded.js";
import type { Doco, Entity } from "./entities.js";

export type LoadedEntitySourceFormat = "postgres";

export interface LoadedEntityParsed {
  data: Record<string, unknown>;
  format?: LoadedEntitySourceFormat;
  /**
   * Full node prose from the storage row — a node's single text home. The
   * indexer reads this for FTS body + embedding text.
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
  doco: Doco;
  entities: Map<EntityId, LoadedEntity>;
  byType: Map<EntityType, LoadedEntity[]>;
  failures: LoadFailure[];
}
