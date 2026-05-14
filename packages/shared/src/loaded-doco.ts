// Types for a loaded Doco — used by both the Postgres loader
// (@doco/index/loadDoco) and the validator (@doco/shared/validate).
//
// The filesystem-based `loadDoco(root)` is gone — Postgres is the only
// source-of-truth (rule_01KRKQDHWNWJAF4YKTMCB2A0D9 — alpha forbids
// back-compat).

import type { Doco, Entity } from "./entities.js";
import type { EntityId, NodeType } from "./branded.js";
import type { ParsedEntityFile } from "./files.js";

/** A loaded entity, optionally with its on-disk source (legacy export only). */
export interface LoadedEntity {
  entity: Entity;
  filePath: string;
  parsed: ParsedEntityFile;
}

export interface LoadFailure {
  filePath: string;
  reason: string;
}

export interface LoadedDoco {
  root: string;
  doco: Doco;
  entities: Map<EntityId, LoadedEntity>;
  byType: Map<NodeType, LoadedEntity[]>;
  failures: LoadFailure[];
}
