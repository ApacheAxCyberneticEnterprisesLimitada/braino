// Types for a loaded Doco — used by both the Postgres loader
// (@doco/index/loadDoco) and the validator (@doco/shared/validate).
//
// The filesystem-based `loadDoco(root)` is gone — Postgres is the only
// source-of-truth (rule_01KRKQDHWNWJAF4YKTMCB2A0D9 — alpha forbids
// back-compat).

import type { EntityId, NodeType } from "./branded.js";
import type { Doco, Entity } from "./entities.js";

export type LoadedEntitySourceFormat = "postgres" | "yaml" | "md" | "json";

export interface LoadedEntityParsed {
  data: Record<string, unknown>;
  body: string;
  format?: LoadedEntitySourceFormat;
  /** Legacy alias kept for index consumers that still expect frontmatter/body separation. */
  frontmatter?: Record<string, unknown>;
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
  byType: Map<NodeType, LoadedEntity[]>;
  failures: LoadFailure[];
}
