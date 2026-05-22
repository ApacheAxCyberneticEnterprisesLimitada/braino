import { join } from "node:path";
import type { EntityType } from "./branded.js";

// Legacy filesystem layout helpers. New runtime code should prefer
// Postgres-backed metadata and use these only for compatibility adapters.

export type EntityFileFormat = "yaml" | "md" | "json";

export interface EntityDirSpec {
  dir: string; // relative to doco root
  format: EntityFileFormat;
  partitioned?: boolean; // legacy month-partitioned layout
}

/**
 * Where each entity type's files live, and what format they take.
 * `doco` is special-cased — it's at the root as `doco.yaml`, not a subfolder.
 */
export const ENTITY_DIRS: Record<Exclude<EntityType, "doco">, EntityDirSpec> = {
  collaborator: { dir: "collaborators", format: "yaml" },
  principal: { dir: "principals", format: "yaml" },
  organization: { dir: "organizations", format: "yaml" },
  intent: { dir: "intents", format: "md" },
  idea: { dir: "ideas", format: "md" },
  rule: { dir: "rules", format: "md" },
  guidance_primitive: { dir: "guidance_primitives", format: "md" },
  neuron_authoring_primitive: { dir: "neuron_authoring_primitives", format: "md" },
  decision: { dir: "decisions", format: "md" },
  action: { dir: "actions", format: "md" },
  /** Log — recorded happening. Markdown body for prose context; concrete
   * `happened_at` + `outputs` in frontmatter. */
  log: { dir: "logs", format: "md" },
  /** Eval — test/eval definition. Markdown body for prose description;
   * structured fields (criterion/input/expected/last_status) in frontmatter. */
  eval: { dir: "evals", format: "md" },
  reference: { dir: "references", format: "yaml" },
  /** State — neuron in a formal state machine. Markdown body for prose
   * description; structured fields (`kind`, `invariants`) in frontmatter. */
  state: { dir: "states", format: "md" },
};

/** Filename pattern: `<type>_<ulid>.<ext>`. */
export function entityFilenameRegex(type: EntityType, format: EntityFileFormat): RegExp {
  return new RegExp(`^${type}_[0-9A-HJKMNP-TV-Z]{26}\\.${format}$`);
}

export function docoYamlPath(root: string): string {
  return join(root, "doco.yaml");
}

export function entityDirPath(root: string, type: Exclude<EntityType, "doco">): string {
  return join(root, ENTITY_DIRS[type].dir);
}

export function glossaryPath(root: string): string {
  return join(root, "glossary.yaml");
}
