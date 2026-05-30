// Single id -> type derivation for @doco/index. Strips the trailing ULID
// segment from an entity id (e.g. "decision_01H…" -> "decision",
// "reference_01H…" -> "reference").
//
// Deliberately a zero-import leaf module: loadDoco, build, and edges all need
// this, and a leaf with no imports cannot participate in the loadDoco<->edges
// import cycle.
//
// NOT parseEntityId() from @doco/shared on purpose: parseEntityId maps the
// historical "reference" prefix to the "reference_entity" type and returns
// null for unrecognized prefixes, whereas this — like the inline
// `id.split("_").slice(0, -1).join("_")` it replaces — returns the literal id
// prefix verbatim for every id. Keeping that exact behavior is required so the
// assembled graph's node/edge `type` values don't change.
export function entityTypeFromId(id: string): string {
  return id.split("_").slice(0, -1).join("_");
}
