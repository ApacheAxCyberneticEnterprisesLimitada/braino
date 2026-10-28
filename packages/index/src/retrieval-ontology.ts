import {
  type RetrievalChunkInput,
  type RetrievalEntityInput,
  type RetrievalRelationshipInput,
  normalizeRetrievalEntityName,
} from "@doco/db";
import type { RetrievalExtraction, RetrievalSourceDocument } from "./retrieval-ingestion.js";

export const RETRIEVAL_ENTITY_TYPES = {
  service: "A deployable software service or independently operated backend.",
  effort: "A named initiative, programme, or codename for a body of work.",
  product: "A product or user-facing application.",
  person: "A named human.",
  team: "An organizational team or group.",
  organization: "A company, institution, or other named legal organization.",
  technology: "A runtime, framework, protocol, platform, or technical dependency.",
  location: "A physical location, cloud region, or hosting environment.",
  status: "An explicit lifecycle or delivery state.",
  capability: "A business or technical function that something provides.",
  communication_channel: "A channel or medium through which people communicate.",
  project: "A named project with an owner, scope, and delivery lifecycle.",
} as const;

export type RetrievalEntityType = keyof typeof RETRIEVAL_ENTITY_TYPES;

/**
 * Relationship labels are intentionally open. Enterprise evidence contains a
 * long tail of useful predicates (ACQUIRED, FOUNDED_BY, HEADQUARTERED_IN,
 * DISTRIBUTED_BY, ...); a central enum silently discards those edges. The
 * persisted graph has one shape: a concise uppercase snake-case predicate.
 */
export type RetrievalRelationshipType = string;
export const RETRIEVAL_RELATIONSHIP_TYPE_PATTERN = "^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){0,7}$";
const RETRIEVAL_RELATIONSHIP_TYPE = new RegExp(RETRIEVAL_RELATIONSHIP_TYPE_PATTERN);

export type RetrievalValidationIssueCode =
  | "ambiguous_relationship_evidence"
  | "duplicate_entity_key"
  | "generic_entity_name"
  | "invalid_entity_name"
  | "invalid_mention"
  | "invalid_relationship_type"
  | "missing_relationship_evidence"
  | "uncertain_relationship"
  | "ungrounded_entity"
  | "unknown_entity_type"
  | "unknown_relationship_endpoint";

export interface RetrievalValidationIssue {
  phase: "entity" | "relationship";
  code: RetrievalValidationIssueCode;
  message: string;
  entityKey?: string;
  relationshipIndex?: number;
}

export interface RetrievalValidationResult {
  extraction: RetrievalExtraction;
  issues: RetrievalValidationIssue[];
}

const UNCERTAIN_EVIDENCE = [
  /\bno decision\b/i,
  /\bnot (?:yet )?(?:decided|approved|confirmed|implemented|supported)\b/i,
  // Keep this case-sensitive so the month in "15 May 2026" is not treated
  // as the modal verb "may".
  /\b(?:may|might|could|would)\b/,
  /\bif\b/i,
  /\bwhether\b/i,
  /\b(?:considered|discussed|proposed|suggested|hypothetical)\b/i,
  /\bpending\s+(?:a\s+)?(?:decision|approval|confirmation)\b/i,
  /\b(?:does|do|did|is|are|was|were|has|have|had|will)\s+not\b/i,
  /\b(?:doesn't|don't|didn't|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't|won't)\b/i,
] as const;

export function hasUncertainRetrievalEvidence(evidence: string): boolean {
  return UNCERTAIN_EVIDENCE.some((pattern) => pattern.test(evidence));
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function isEntityType(value: string): value is RetrievalEntityType {
  return Object.hasOwn(RETRIEVAL_ENTITY_TYPES, value);
}

function isRelationshipType(value: string): value is RetrievalRelationshipType {
  return value.length <= 80 && RETRIEVAL_RELATIONSHIP_TYPE.test(value);
}

const GENERIC_ENTITY_NAMES: Partial<Record<RetrievalEntityType, ReadonlySet<string>>> = {
  organization: new Set(["business", "company", "institution", "organization"]),
  team: new Set(["department", "group", "squad", "team"]),
  service: new Set(["backend", "service"]),
  product: new Set(["app", "application", "product"]),
  person: new Set(["founder", "person", "user"]),
  technology: new Set(["database", "framework", "model", "runtime", "technology"]),
  location: new Set(["headquarters", "location", "office", "region"]),
  capability: new Set(["capability", "feature", "function"]),
  communication_channel: new Set(["channel"]),
  project: new Set(["project"]),
  effort: new Set(["effort", "initiative", "program", "programme"]),
};

function hasOnlyGenericEntityNames(entity: RetrievalEntityInput): boolean {
  const genericNames = isEntityType(entity.type) ? GENERIC_ENTITY_NAMES[entity.type] : undefined;
  if (!genericNames) return false;
  const labels = [entity.name, ...(entity.aliases ?? [])]
    .map(normalizeText)
    .map((label) => label.replace(/^(?:a|an|the)\s+/, ""))
    .filter(Boolean);
  return labels.length > 0 && labels.every((label) => genericNames.has(label));
}

function groundedEntityMention(
  entity: RetrievalEntityInput,
  chunks: RetrievalChunkInput[],
): "valid" | "invalid_mention" | "ungrounded" {
  const labels = [entity.name, ...(entity.aliases ?? [])].map(normalizeText).filter(Boolean);
  if (labels.length === 0 || entity.mentions.length === 0) return "ungrounded";

  let sawValidChunk = false;
  for (const mention of entity.mentions) {
    const chunk = chunks[mention.chunkIndex];
    if (!chunk) return "invalid_mention";
    sawValidChunk = true;
    const start = mention.startOffset;
    const end = mention.endOffset;
    if (start !== undefined || end !== undefined) {
      if (
        start === undefined ||
        end === undefined ||
        end === null ||
        start < 0 ||
        end <= start ||
        end > chunk.text.length
      ) {
        return "invalid_mention";
      }
      const cited = normalizeText(chunk.text.slice(start, end));
      if (labels.some((label) => cited === label)) return "valid";
      continue;
    }
    const normalizedChunk = normalizeText(chunk.text);
    if (labels.some((label) => normalizedChunk.includes(label))) return "valid";
  }
  return sawValidChunk ? "ungrounded" : "invalid_mention";
}

function groundedRelationshipEvidence(
  relation: RetrievalRelationshipInput,
  chunks: RetrievalChunkInput[],
): string | null {
  const chunk = chunks[relation.chunkIndex];
  if (!chunk) return null;
  const fact = normalizeText(relation.fact);
  return fact && normalizeText(chunk.text).includes(fact) ? relation.fact : null;
}

function evidenceNamesEntity(evidence: string, entity: RetrievalEntityInput): boolean {
  const normalizedEvidence = ` ${normalizeText(evidence)} `;
  return [entity.name, ...(entity.aliases ?? [])]
    .map(normalizeText)
    .filter(Boolean)
    .some((label) => normalizedEvidence.includes(` ${label} `));
}

function isSingleSentence(evidence: string): boolean {
  const withoutFinalPunctuation = evidence.trim().replace(/[.!?]+$/, "");
  return !/[.!?]\s+(?=[\p{Lu}\p{N}])/u.test(withoutFinalPunctuation);
}

export function validateRetrievalExtraction(
  _document: RetrievalSourceDocument,
  chunks: RetrievalChunkInput[],
  extraction: RetrievalExtraction,
): RetrievalValidationResult {
  const issues: RetrievalValidationIssue[] = [];
  const entities: RetrievalEntityInput[] = [];
  const entityByKey = new Map<string, RetrievalEntityInput>();
  const seenKeys = new Set<string>();

  for (const entity of extraction.entities) {
    if (seenKeys.has(entity.key)) {
      issues.push({
        phase: "entity",
        code: "duplicate_entity_key",
        entityKey: entity.key,
        message: `Entity key ${entity.key} appears more than once.`,
      });
      continue;
    }
    seenKeys.add(entity.key);
    if (!isEntityType(entity.type)) {
      issues.push({
        phase: "entity",
        code: "unknown_entity_type",
        entityKey: entity.key,
        message: `Entity ${entity.key} uses unknown type ${entity.type}.`,
      });
      continue;
    }
    if (
      ![entity.name, ...(entity.aliases ?? [])].some((name) =>
        Boolean(normalizeRetrievalEntityName(name)),
      )
    ) {
      issues.push({
        phase: "entity",
        code: "invalid_entity_name",
        entityKey: entity.key,
        message: `Entity ${entity.key} has no usable name.`,
      });
      continue;
    }
    if (hasOnlyGenericEntityNames(entity)) {
      issues.push({
        phase: "entity",
        code: "generic_entity_name",
        entityKey: entity.key,
        message: `Entity ${entity.key} is a generic role word, not a stable graph identity.`,
      });
      continue;
    }
    const grounding = groundedEntityMention(entity, chunks);
    if (grounding !== "valid") {
      issues.push({
        phase: "entity",
        code: grounding === "invalid_mention" ? "invalid_mention" : "ungrounded_entity",
        entityKey: entity.key,
        message:
          grounding === "invalid_mention"
            ? `Entity ${entity.key} cites an invalid chunk or character range.`
            : `Entity ${entity.key} is not named by its cited evidence.`,
      });
      continue;
    }
    entities.push(entity);
    entityByKey.set(entity.key, entity);
  }

  const relationships: RetrievalRelationshipInput[] = [];
  for (const [relationshipIndex, relation] of extraction.relationships.entries()) {
    if (!isRelationshipType(relation.type)) {
      issues.push({
        phase: "relationship",
        code: "invalid_relationship_type",
        relationshipIndex,
        message: `Relationship ${relationshipIndex} must use a concise uppercase snake-case type.`,
      });
      continue;
    }
    const from = entityByKey.get(relation.fromKey);
    const to = entityByKey.get(relation.toKey);
    if (!from || !to) {
      issues.push({
        phase: "relationship",
        code: "unknown_relationship_endpoint",
        relationshipIndex,
        message: `Relationship ${relationshipIndex} references an entity that was not accepted.`,
      });
      continue;
    }
    const evidence = groundedRelationshipEvidence(relation, chunks);
    if (!evidence) {
      issues.push({
        phase: "relationship",
        code: "missing_relationship_evidence",
        relationshipIndex,
        message: `Relationship ${relationshipIndex} does not quote text from its cited chunk.`,
      });
      continue;
    }
    if (
      !isSingleSentence(evidence) ||
      !evidenceNamesEntity(evidence, from) ||
      !evidenceNamesEntity(evidence, to)
    ) {
      issues.push({
        phase: "relationship",
        code: "ambiguous_relationship_evidence",
        relationshipIndex,
        message: `Relationship ${relationshipIndex} must cite one sentence that names both endpoints.`,
      });
      continue;
    }
    if (hasUncertainRetrievalEvidence(evidence)) {
      issues.push({
        phase: "relationship",
        code: "uncertain_relationship",
        relationshipIndex,
        message: `Relationship ${relationshipIndex} is stated as uncertain, hypothetical, or negated.`,
      });
      continue;
    }
    relationships.push(relation);
  }

  return { extraction: { entities, relationships }, issues };
}

export function formatRetrievalOntologyForPrompt(): string {
  const entities = Object.entries(RETRIEVAL_ENTITY_TYPES)
    .map(([type, description]) => `- ${type}: ${description}`)
    .join("\n");
  return [
    "Entity types:",
    entities,
    "",
    "Relationship types:",
    "- Use a concise uppercase snake-case predicate that directly expresses the cited sentence.",
    "- Predicates are open, not selected from a fixed list.",
    "- Examples: ACQUIRED, FOUNDED_BY, HEADQUARTERED_IN, DISTRIBUTED_BY, USES.",
    "- Preserve direction: in 'Northstar acquired Radar', use Northstar -ACQUIRED-> Radar.",
    "",
    "Only use the entity types listed above.",
    "Every entity must quote a real mention, and every relationship must quote exact supporting text.",
    "Do not extract negated, hypothetical, proposed, or undecided relationships.",
  ].join("\n");
}
