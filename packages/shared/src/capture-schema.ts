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

export function renderCaptureBodyFields(type: string, indent = "  "): string {
  const spec = captureSchema(type);
  if (!spec) return "";
  const width = Math.max(...spec.fields.map((f) => f.name.length));
  const requirementWidth = "requirement".length;
  return spec.fields
    .map((f) => {
      const name = f.name.padEnd(width, " ");
      const req = f.requirement.padEnd(requirementWidth, " ");
      return `${indent}${name}  ${req}  ${f.description}`;
    })
    .join("\n");
}

export function renderCapturePatchFields(type: string, indent = "    "): string {
  const spec = captureSchema(type);
  if (!spec) return "";
  return `${indent}${spec.patchFields.join(" / ")}`;
}

export function renderCaptureCheatsheet(): string {
  return Object.values(CAPTURE_SCHEMAS)
    .map((spec) => {
      const body = spec.fields
        .map((f) => `${f.name}${f.requirement === "required" ? "*" : "?"}`)
        .join(", ");
      return `- ${spec.label}: { ${body} }`;
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
