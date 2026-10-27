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
  technology: "A runtime, framework, protocol, platform, or technical dependency.",
  location: "A physical location, cloud region, or hosting environment.",
  status: "An explicit lifecycle or delivery state.",
  capability: "A business or technical function that something provides.",
  communication_channel: "A channel or medium through which people communicate.",
  project: "A named project with an owner, scope, and delivery lifecycle.",
} as const;

export type RetrievalEntityType = keyof typeof RETRIEVAL_ENTITY_TYPES;

interface RetrievalRelationshipDefinition {
  description: string;
  from: readonly RetrievalEntityType[];
  to: readonly RetrievalEntityType[];
  evidencePatterns: readonly RegExp[];
}

export const RETRIEVAL_RELATIONSHIPS = {
  USES: {
    description: "The source explicitly uses the target for its work or operation.",
    from: ["person", "team", "service", "product", "effort", "project"],
    to: ["technology", "service", "product", "communication_channel"],
    evidencePatterns: [
      /\buses?\b/i,
      /\binstalls?\b/i,
      /\btargets?\b/i,
      /\bbuilds?\s+(?:with|on)\b/i,
      /\bruns?\s+on\b/i,
    ],
  },
  OWNS: {
    description: "The source person, team, or service is accountable for the target.",
    from: ["person", "team", "service"],
    to: ["capability", "effort", "project", "product", "service"],
    evidencePatterns: [
      /\bowns?\b/i,
      /\bownership\b/i,
      /\bowned by\b/i,
      /\bled by\b/i,
      /\baccountable for\b/i,
    ],
  },
  RESPONSIBLE_FOR: {
    description: "The source is explicitly responsible for operating or performing the target.",
    from: ["person", "team", "service"],
    to: ["capability", "effort", "project", "product", "service"],
    evidencePatterns: [
      /\bresponsible for\b/i,
      /\bhandles?\b/i,
      /\bprocess(?:es|ing)?\b/i,
      /\bmanages?\b/i,
      /\boperates?\b/i,
      /\bperforms?\b/i,
    ],
  },
  PROVIDES: {
    description: "The source explicitly provides or offers the target.",
    from: ["team", "service", "product"],
    to: ["capability", "communication_channel", "technology", "product", "service"],
    evidencePatterns: [/\bsupports?\b/i, /\bprovides?\b/i, /\benables?\b/i, /\boffers?\b/i],
  },
  PART_OF: {
    description: "The source is explicitly a component or subdivision of the target.",
    from: ["team", "service", "product", "technology", "capability", "effort", "project"],
    to: ["team", "service", "product", "technology", "capability", "effort", "project"],
    evidencePatterns: [/\bpart of\b/i, /\bcomponent of\b/i, /\bwithin\b/i, /\bbelongs to\b/i],
  },
  MEMBER_OF: {
    description: "The source person or team is explicitly a member of the target team.",
    from: ["person", "team"],
    to: ["team"],
    evidencePatterns: [/\bmember of\b/i, /\bworks (?:in|for|on)\b/i, /\bbelongs to\b/i],
  },
  REPORTS_TO: {
    description: "The source person or team explicitly reports to the target person or team.",
    from: ["person", "team"],
    to: ["person", "team"],
    evidencePatterns: [/\breports? to\b/i, /\bmanaged by\b/i, /\bmanager is\b/i],
  },
  LOCATED_IN: {
    description: "The source is explicitly located, hosted, or deployed in the target location.",
    from: ["person", "team", "service", "product", "effort", "project"],
    to: ["location"],
    evidencePatterns: [
      /\bdeploy(?:ed|s|ment)?\s+(?:in|to|on)\b/i,
      /\bhosted\s+(?:in|on|at)\b/i,
      /\blocated\s+(?:in|at)\b/i,
      /\bbased\s+in\b/i,
    ],
  },
  HAS_STATUS: {
    description: "The source has the explicitly stated target status.",
    from: ["effort", "project", "product", "service"],
    to: ["status"],
    evidencePatterns: [
      /\bstatus\b/i,
      /\bentered\b/i,
      /\bis\s+(?:active|blocked|cancelled|complete|completed|drafting|paused|pending|planned)\b/i,
    ],
  },
  CREATED_FOR: {
    description: "The source was created for the target capability or purpose.",
    from: ["service", "product", "effort", "project"],
    to: ["capability"],
    evidencePatterns: [
      /\bcreated\s+(?:for|to)\b/i,
      /\bbuilt\s+(?:for|to)\b/i,
      /\bintroduced\s+(?:for|to)\b/i,
    ],
  },
  DEPENDS_ON: {
    description: "The source has an explicit operational or technical dependency on the target.",
    from: ["service", "product", "technology"],
    to: ["service", "technology"],
    evidencePatterns: [/\bdepends?\s+on\b/i, /\brequires?\b/i, /\bdependency\b/i],
  },
} as const satisfies Record<string, RetrievalRelationshipDefinition>;

export type RetrievalRelationshipType = keyof typeof RETRIEVAL_RELATIONSHIPS;

export type RetrievalValidationIssueCode =
  | "duplicate_entity_key"
  | "invalid_entity_name"
  | "invalid_mention"
  | "invalid_relationship_types"
  | "missing_relationship_evidence"
  | "uncertain_relationship"
  | "ungrounded_entity"
  | "unknown_entity_type"
  | "unknown_relationship_endpoint"
  | "unknown_relationship_type"
  | "unsupported_predicate";

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
  /\b(?:may|might|could|would)\b/i,
  /\bif\b/i,
  /\bwhether\b/i,
  /\b(?:considered|discussed|proposed|suggested|hypothetical)\b/i,
  /\bpending\s+(?:a\s+)?(?:decision|approval|confirmation)\b/i,
  /\b(?:does|do|did|is|are|was|were|has|have|had|will)\s+not\b/i,
  /\b(?:doesn't|don't|didn't|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't|won't)\b/i,
] as const;

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
  return Object.hasOwn(RETRIEVAL_RELATIONSHIPS, value);
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

function relationshipTypesAllowed(
  definition: RetrievalRelationshipDefinition,
  from: RetrievalEntityInput,
  to: RetrievalEntityInput,
): boolean {
  return (
    isEntityType(from.type) &&
    isEntityType(to.type) &&
    definition.from.includes(from.type) &&
    definition.to.includes(to.type)
  );
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
        code: "unknown_relationship_type",
        relationshipIndex,
        message: `Relationship ${relationshipIndex} uses unknown type ${relation.type}.`,
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
    const definition: RetrievalRelationshipDefinition = RETRIEVAL_RELATIONSHIPS[relation.type];
    if (!relationshipTypesAllowed(definition, from, to)) {
      issues.push({
        phase: "relationship",
        code: "invalid_relationship_types",
        relationshipIndex,
        message: `${relation.type} does not allow ${from.type} -> ${to.type}.`,
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
    if (UNCERTAIN_EVIDENCE.some((pattern) => pattern.test(evidence))) {
      issues.push({
        phase: "relationship",
        code: "uncertain_relationship",
        relationshipIndex,
        message: `Relationship ${relationshipIndex} is stated as uncertain, hypothetical, or negated.`,
      });
      continue;
    }
    if (!definition.evidencePatterns.some((pattern) => pattern.test(evidence))) {
      issues.push({
        phase: "relationship",
        code: "unsupported_predicate",
        relationshipIndex,
        message: `Relationship ${relationshipIndex} lacks evidence for predicate ${relation.type}.`,
      });
      continue;
    }
    relationships.push(relation);
  }

  return { extraction: { entities, relationships }, issues };
}

function joined(values: readonly string[]): string {
  return values.join("|");
}

export function formatRetrievalOntologyForPrompt(): string {
  const entities = Object.entries(RETRIEVAL_ENTITY_TYPES)
    .map(([type, description]) => `- ${type}: ${description}`)
    .join("\n");
  const relationships = Object.entries(RETRIEVAL_RELATIONSHIPS)
    .map(
      ([type, definition]) =>
        `- ${type}: ${joined(definition.from)} -> ${joined(definition.to)}. ${definition.description}`,
    )
    .join("\n");
  return [
    "Entity types:",
    entities,
    "",
    "Relationship types and canonical direction:",
    relationships,
    "",
    "Only use the entity and relationship types listed above.",
    "Every entity must quote a real mention, and every relationship must quote exact supporting text.",
    "Do not extract negated, hypothetical, proposed, or undecided relationships.",
  ].join("\n");
}
