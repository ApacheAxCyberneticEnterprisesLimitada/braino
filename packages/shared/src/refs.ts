import { type EntityId, isEntityId } from "./branded.js";
import type { LoadedDoco } from "./loaded-doco.js";

export interface OrphanRef {
  source: EntityId;
  field: string; // dotted path within the source entity
  target: string; // the unresolved id string
}

/**
 * Walk every loaded entity and find every entity-ID-shaped value that doesn't resolve
 * to a loaded entity. The Doco's own `id` (self-reference) is allowed.
 *
 * Cross-Doco references with the form `<namespace>:<type>_<ulid>` are skipped — they
 * resolve via the imports machinery, which isn't built yet.
 */
export function findOrphanRefs(loaded: LoadedDoco): OrphanRef[] {
  const orphans: OrphanRef[] = [];
  const known = new Set<string>(loaded.entities.keys());
  known.add(loaded.doco.id);

  for (const [id, le] of loaded.entities) {
    walk(le.entity, "", (path, value) => {
      if (typeof value !== "string") return;
      if (value.includes(":")) return; // cross-Doco, skip
      if (!isEntityId(value)) return;
      if (known.has(value)) return;
      orphans.push({ source: id, field: path, target: value });
    });
  }

  return orphans;
}

type Visitor = (path: string, value: unknown) => void;

function walk(node: unknown, path: string, visit: Visitor): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      walk(node[i], `${path}[${i}]`, visit);
    }
    return;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      const childPath = path ? `${path}.${k}` : k;
      walk(v, childPath, visit);
    }
    return;
  }
  visit(path, node);
}
