import type { EntityId } from "./branded.js";
import type { LoadedDoco } from "./loaded-doco.js";
import { type OrphanRef, findOrphanRefs } from "./refs.js";

export type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
  severity: ValidationSeverity;
  source: EntityId | "doco" | "load";
  filePath?: string;
  kind: "orphan-ref" | "load";
  message: string;
  detail?: Record<string, unknown>;
}

export interface ValidationReport {
  totalEntities: number;
  entitiesByType: Record<string, number>;
  orphanRefs: number;
  loadFailures: number;
  issues: ValidationIssue[];
  ok: boolean;
}

/**
 * Validate a loaded Doco. Two checks:
 *
 *   1. Every entity in the Doco loaded without error.
 *   2. Every id-shaped reference resolves to a real entity in the Doco
 *      (orphan-ref detection).
 *
 * Per-entity JSON Schema validation was removed — the TypeScript types in
 * `@doco/shared/entities.ts` are the source of truth for entity shape;
 * agents/CLI consumers see type errors there. The connectivity check above
 * catches the only failure that schema-validation actually caught in
 * practice (a typoed id field). Keeping a parallel JSON Schema in sync
 * with the TS types was a drift hazard with no offsetting benefit.
 */
export async function validateDoco(loaded: LoadedDoco): Promise<ValidationReport> {
  const issues: ValidationIssue[] = [];

  // 1. Load failures from the loader.
  for (const f of loaded.failures) {
    issues.push({
      severity: "error",
      source: "load",
      filePath: f.filePath,
      kind: "load",
      message: f.reason,
    });
  }

  // 2. Orphan-ref detection.
  const orphans = findOrphanRefs(loaded);
  for (const o of orphans) {
    issues.push(makeOrphanIssue(o));
  }

  // 3. Build report.
  const entitiesByType: Record<string, number> = {};
  for (const [t, list] of loaded.byType) {
    entitiesByType[t] = list.length;
  }

  const orphanRefs = issues.filter((i) => i.kind === "orphan-ref").length;
  const loadFailures = issues.filter((i) => i.kind === "load").length;

  return {
    totalEntities: loaded.entities.size,
    entitiesByType,
    orphanRefs,
    loadFailures,
    issues,
    ok: issues.every((i) => i.severity !== "error"),
  };
}

function makeOrphanIssue(o: OrphanRef): ValidationIssue {
  return {
    severity: "error",
    source: o.source,
    kind: "orphan-ref",
    message: `Reference to unknown entity ${o.target} (at ${o.field})`,
    detail: { field: o.field, target: o.target },
  };
}
