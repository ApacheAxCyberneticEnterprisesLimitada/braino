import { join } from "node:path";
import type { NodeType } from "./branded.js";

export type EntityFileFormat = "yaml" | "md" | "json";

export interface EntityDirSpec {
  dir: string; // relative to doco root
  format: EntityFileFormat;
  partitioned?: boolean; // legacy month-partitioned layout
}

/**
 * Where each node type's files live, and what format they take. Mirrors SCHEMA.md §2.
 * `doco` is special-cased — it's at the root as `doco.yaml`, not a subfolder.
 */
export const ENTITY_DIRS: Record<Exclude<NodeType, "doco">, EntityDirSpec> = {
  principal: { dir: "principals", format: "yaml" },
  organization: { dir: "organizations", format: "yaml" },
  intent: { dir: "intents", format: "md" },
  idea: { dir: "ideas", format: "md" },
  rule: { dir: "rules", format: "md" },
  decision: { dir: "decisions", format: "md" },
  action: { dir: "actions", format: "md" },
  /** Log — recorded happening. Markdown body for prose context; concrete
   * `happened_at` + `outputs` in frontmatter. */
  log: { dir: "logs", format: "md" },
  /** Eval — test/eval definition. Markdown body for prose description;
   * structured fields (criterion/input/expected/last_status) in frontmatter. */
  eval: { dir: "evals", format: "md" },
  reference: { dir: "references", format: "yaml" },
  scope: { dir: "scopes", format: "yaml" },
  /** State — node in a formal state machine. Markdown body for prose
   * description; structured fields (`kind`, `invariants`) in frontmatter.
   * Per decision_01KRRR5BQ16ASY8HQEE0V499YG. */
  state: { dir: "states", format: "md" },
};

/** Filename pattern: `<type>_<ulid>.<ext>`. */
export function entityFilenameRegex(type: NodeType, format: EntityFileFormat): RegExp {
  return new RegExp(`^${type}_[0-9A-HJKMNP-TV-Z]{26}\\.${format}$`);
}

export function docoYamlPath(root: string): string {
  return join(root, "doco.yaml");
}

export function entityDirPath(root: string, type: Exclude<NodeType, "doco">): string {
  return join(root, ENTITY_DIRS[type].dir);
}

export function glossaryPath(root: string): string {
  return join(root, "glossary.yaml");
}
