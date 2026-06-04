export type CaptureFieldRequirement = "required" | "optional";

export interface CaptureFieldSpec {
  name: string;
  requirement: CaptureFieldRequirement;
  description: string;
}

export interface CaptureSchema {
  entityType: string;
  label: string;
  collection: string;
  defaultLifecycle: "drafting" | "queued" | "active" | "retired";
  fields: readonly CaptureFieldSpec[];
  patchFields: readonly string[];
}

const COMMON_OPTIONAL_FIELDS: readonly CaptureFieldSpec[] = [
  field("lifecycle", "optional", 'one of "drafting" | "queued" | "active" | "retired"'),
  field("deprecated", "optional", "boolean warning label; lifecycle is unchanged"),
  field("outcome", "optional", '"succeeded" | "failed"'),
];

export const CAPTURE_SCHEMAS = {
  decision: schema("decision", "Decision", "decisions", "active", [
    field("decision", "required", "full prose of the decision; first line is the label"),
    field("question", "required", "the question the Decision answers"),
    field(
      "chosen",
      "optional",
      "chosen resolution; templates that need it can require it with authoring policy",
    ),
    field("alternatives", "optional", '[{ "name": "...", "rejected_because": "..." }, ...]'),
    ...COMMON_OPTIONAL_FIELDS,
  ]),
  intent: schema("intent", "Intent", "intents", "active", [
    field("intent", "required", "full prose: what someone wants, why, success criteria"),
    ...COMMON_OPTIONAL_FIELDS,
  ]),
  action: schema("action", "Action", "actions", "retired", [
    field("action", "required", "full prose: what was done plus context"),
    field("verb", "required", 'short verb such as "refactor", "migrate", "deploy"'),
    field("inputs", "optional", "verb-specific inputs, any JSON shape"),
    field("outputs", "optional", "verb-specific outputs, any JSON shape"),
    ...COMMON_OPTIONAL_FIELDS,
  ]),
  log: schema("log", "Log", "logs", "retired", [
    field("log", "required", "full prose: what happened, when, in what state"),
    field("verb", "required", 'past-tense verb such as "pushed", "deployed", "verified"'),
    field("happened_at", "required", "ISO 8601 timestamp"),
    field("outputs", "required", "non-empty object with concrete results"),
    field("inputs", "optional", "event inputs, any JSON shape"),
    ...COMMON_OPTIONAL_FIELDS,
  ]),
  rule: schema("rule", "Rule", "rules", "active", [
    field("rule", "required", "full prose: rule statement, rationale, scope, exceptions"),
    field("predicate", "required", "machine-checkable or prose predicate"),
    field("enforced_by", "optional", '"runtime" | "review" | "manual"'),
    field("severity", "optional", '"hard" | "soft"'),
    ...COMMON_OPTIONAL_FIELDS,
  ]),
  eval: schema("eval", "Eval", "evals", "active", [
    field("eval", "required", "full prose: what is being checked plus rationale"),
    field("criterion", "required", '{ "kind": "exact" | "shape" | "llm-judge", "spec": "..." }'),
    field("kind", "optional", '"unit" | "integration" | "eval" | "process" | "doc-consistency"'),
    field("expected_status", "optional", '"pass" | "fail"'),
    field("how_to_run", "optional", "free-form reproduction steps"),
    field("input", "optional", "input value, any JSON shape"),
    field("expected", "optional", "expected outcome, any JSON shape"),
    ...COMMON_OPTIONAL_FIELDS,
  ]),
  reference: schema("reference", "Reference", "references", "active", [
    field("reference", "required", "full prose: human-readable label for the source"),
    field("ref_type", "required", '"file" | "url" | "ticket" | "commit" | "document" | "other"'),
    field("locator", "required", "path, URL, ticket id, commit sha, or other locator"),
    field("content_hash", "optional", "source content hash"),
    ...COMMON_OPTIONAL_FIELDS,
  ]),
  state: schema("state", "State", "states", "active", [
    field("state", "required", "full prose: state description, invariants explained"),
    field("kind", "required", '"initial" | "intermediate" | "terminal"'),
    field("invariants", "optional", "array of free-form predicates true while in this State"),
    ...COMMON_OPTIONAL_FIELDS,
  ]),
  idea: schema("idea", "Idea", "ideas", "drafting", [
    field("idea", "required", "full prose: the idea, context, tradeoffs"),
    field("promoted_to", "optional", "entity id once the idea is picked up"),
    field("rejection_reason", "optional", "why the idea was rejected or parked"),
    ...COMMON_OPTIONAL_FIELDS,
  ]),
} as const satisfies Record<string, CaptureSchema>;

export function captureSchema(type: string): CaptureSchema | null {
  return (CAPTURE_SCHEMAS as Record<string, CaptureSchema>)[type] ?? null;
}

/**
 * Lifecycle-envelope keys that live at the TOP LEVEL of a capture body, not in
 * `attributes`. (`prose` and `kind` are the other top-level keys; everything
 * else is an attribute hint.)
 */
const ENVELOPE_FIELDS: ReadonlySet<string> = new Set([
  "lifecycle",
  "deprecated",
  "outcome",
  "created_by_user_id",
]);

/**
 * Classify a schema field for the raw `{prose, kind?, attributes}` body shape:
 *  - the type-named prose field → `prose`
 *  - `kind` → the top-level promoted classifier
 *  - lifecycle envelope keys → top-level
 *  - everything else → an `attributes.<name>` hint
 */
function fieldSlot(spec: CaptureSchema, name: string): "prose" | "kind" | "envelope" | "attribute" {
  if (name === spec.entityType) return "prose";
  if (name === "kind") return "kind";
  if (ENVELOPE_FIELDS.has(name)) return "envelope";
  return "attribute";
}

/**
 * Render the capture body for the `.txt` specs in the raw row shape the API now
 * exposes: a top-level `prose` (and `kind` when the type has one), the
 * lifecycle envelope, and the per-type fields nested as `attributes` hints.
 * CAPTURE_SCHEMAS stays the single source of those attribute hints.
 */
export function renderCaptureBodyFields(type: string, indent = "  "): string {
  const spec = captureSchema(type);
  if (!spec) return "";

  const proseDesc =
    spec.fields.find((f) => f.name === spec.entityType)?.description ??
    "full prose; first line is the label";
  const kindField = spec.fields.find((f) => f.name === "kind");
  const attributeFields = spec.fields.filter((f) => fieldSlot(spec, f.name) === "attribute");
  const envelopeFields = spec.fields.filter((f) => fieldSlot(spec, f.name) === "envelope");

  // Width covers the deepest label so the descriptions line up; attribute rows
  // are indented one extra step under the `attributes` heading.
  const attrIndent = `${indent}  `;
  const labels = [
    "prose",
    ...(kindField ? ["kind"] : []),
    ...attributeFields.map((f) => f.name),
    ...envelopeFields.map((f) => f.name),
  ];
  const width = Math.max(...labels.map((l) => l.length));
  const requirementWidth = "requirement".length;
  const row = (pad: string, name: string, req: CaptureFieldRequirement, desc: string) =>
    `${pad}${name.padEnd(width, " ")}  ${req.padEnd(requirementWidth, " ")}  ${desc}`;

  const lines: string[] = [row(indent, "prose", "required", proseDesc)];
  if (kindField) lines.push(row(indent, "kind", kindField.requirement, kindField.description));
  if (attributeFields.length > 0) {
    lines.push(
      `${indent}${"attributes".padEnd(width, " ")}  ${"object".padEnd(requirementWidth, " ")}  per-type fields (keys below):`,
    );
    for (const f of attributeFields)
      lines.push(row(attrIndent, f.name, f.requirement, f.description));
  }
  for (const f of envelopeFields) lines.push(row(indent, f.name, f.requirement, f.description));
  return lines.join("\n");
}

export function renderCapturePatchFields(type: string, indent = "    "): string {
  const spec = captureSchema(type);
  if (!spec) return "";
  return `${indent}${spec.patchFields.join(" / ")}`;
}

/**
 * One-line-per-type cheatsheet in the raw row shape: `prose` (and `kind`) at the
 * top level, the per-type hints grouped under `attributes`.
 */
export function renderCaptureCheatsheet(): string {
  return Object.values(CAPTURE_SCHEMAS)
    .map((spec) => {
      const mark = (f: CaptureFieldSpec) => `${f.name}${f.requirement === "required" ? "*" : "?"}`;
      const top: string[] = ["prose*"];
      const kindField = spec.fields.find((f) => f.name === "kind");
      if (kindField) top.push(mark(kindField));
      const attrs = spec.fields.filter((f) => fieldSlot(spec, f.name) === "attribute").map(mark);
      const parts = [...top, ...(attrs.length > 0 ? [`attributes: { ${attrs.join(", ")} }`] : [])];
      return `- ${spec.label}: { ${parts.join(", ")} }`;
    })
    .join("\n");
}

function schema(
  entityType: string,
  label: string,
  collection: string,
  defaultLifecycle: CaptureSchema["defaultLifecycle"],
  fields: readonly CaptureFieldSpec[],
): CaptureSchema {
  return {
    entityType,
    label,
    collection,
    defaultLifecycle,
    fields,
    patchFields: fields.filter((f) => f.name !== "created_by_user_id").map((f) => f.name),
  };
}

function field(
  name: string,
  requirement: CaptureFieldRequirement,
  description: string,
): CaptureFieldSpec {
  return { name, requirement, description };
}
