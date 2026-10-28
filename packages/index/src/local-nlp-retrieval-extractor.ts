import type {
  RetrievalChunkInput,
  RetrievalEntityInput,
  RetrievalRelationshipInput,
} from "@doco/db";
import type {
  RetrievalExtraction,
  RetrievalExtractor,
  RetrievalSourceDocument,
} from "./retrieval-ingestion.js";
import {
  type RetrievalEntityType,
  type RetrievalRelationshipType,
  hasUncertainRetrievalEvidence,
} from "./retrieval-ontology.js";

interface PredicateRule {
  type: RetrievalRelationshipType;
  pattern: RegExp;
  fromType: RetrievalEntityType;
  toType: RetrievalEntityType;
  reverse?: boolean;
}

const PREDICATES: readonly PredicateRule[] = [
  {
    type: "USES",
    pattern: /\b(?:builds?\s+(?:with|on)|(?:runs?|ran)\s+on|uses?|installs?|targets?)\b/i,
    fromType: "service",
    toType: "technology",
  },
  {
    type: "OWNS",
    pattern: /\b(?:owns?|accountable\s+for)\b/i,
    fromType: "service",
    toType: "capability",
  },
  {
    type: "OWNS",
    pattern: /\b(?:is|are|was|were)\s+(?:owned|led)\s+by\b/i,
    fromType: "person",
    toType: "project",
    reverse: true,
  },
  {
    type: "RESPONSIBLE_FOR",
    pattern: /\b(?:responsible\s+for|handles?|process(?:es|ing)?|manages?|operates?|performs?)\b/i,
    fromType: "service",
    toType: "capability",
  },
  {
    type: "PROVIDES",
    pattern: /\b(?:supports?|provides?|enables?|offers?)\b/i,
    fromType: "service",
    toType: "capability",
  },
  {
    type: "PART_OF",
    pattern: /\b(?:is|are|was|were)?\s*(?:part|component)\s+of\b/i,
    fromType: "service",
    toType: "product",
  },
  {
    type: "MEMBER_OF",
    pattern: /\b(?:is|are|was|were)?\s*(?:a\s+)?member\s+of\b/i,
    fromType: "person",
    toType: "team",
  },
  {
    type: "REPORTS_TO",
    pattern: /\b(?:reports?\s+to|is\s+managed\s+by|manager\s+is)\b/i,
    fromType: "person",
    toType: "person",
  },
  {
    type: "LOCATED_IN",
    pattern:
      /\b(?:is|are|was|were)?\s*(?:deployed|hosted|located)\s+(?:in|to|on|at)|\b(?:is|are|was|were)?\s*based\s+in\b/i,
    fromType: "service",
    toType: "location",
  },
  {
    type: "CREATED_FOR",
    pattern: /\b(?:created|built|introduced)\s+(?:for|to)\b/i,
    fromType: "service",
    toType: "capability",
  },
  {
    type: "DEPENDS_ON",
    pattern: /\b(?:depends?\s+on|requires?)\b/i,
    fromType: "service",
    toType: "technology",
  },
] as const;

const STATUS_PATTERN =
  /\b(?:is|are|was|were)\s+(active|blocked|cancelled|complete|completed|drafting|paused|pending|planned)\b/i;
const KIND_SUFFIX = /\s+(?:initiative|programme|program|effort)\s*$/i;
const LEADING_CONTEXT = /^(?:(?:today|currently|now)\s+|(?:the|a|an)\s+)/i;
const TECH_HINT =
  /\b(?:api|aws|corretto|database|db|ec2|ecs|fargate|framework|java|jdk|kafka|kubernetes|linux|model|node\.js|postgres|protocol|python|qdrant|runtime|scala|sdk|temurin)\b/i;
const LOCATION_HINT = /^(?:[a-z]{2,}-[a-z]+-\d|production|preview|staging|local)$/i;
const CHANNEL_HINT = /\b(?:chat|email|slack|teams|telegram|whatsapp)\b/i;

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function sentences(text: string): string[] {
  return [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(text)]
    .map(({ segment }) => segment.trim())
    .filter(Boolean);
}

function relationClauses(sentence: string): string[] {
  return sentence
    .split(/,\s*(?:while|but)\s+|;\s*/i)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function stripWrapping(value: string): string {
  return value
    .trim()
    .replace(LEADING_CONTEXT, "")
    .replace(/^(?:before|since|after)\b[^,]*,\s*/i, "")
    .replace(/^(?:the|a|an)\s+/i, "")
    .replace(/\s+(?:is|are|was|were|has|have|had)\s*$/i, "")
    .replace(/^[`'"“”]+|[`'"“”.,;:!?]+$/g, "")
    .trim();
}

function subjectPhrase(value: string): string {
  const withoutAliasAside = value.replace(
    /,\s*(?:also\s+called|known\s+as)\s+[`'"“”]?[\p{L}\p{N}_.-]+[`'"“”]?\s*,?/giu,
    "",
  );
  let subject = withoutAliasAside.split(/\b(?:but|while)\b|[;,]/i).at(-1) ?? withoutAliasAside;
  subject = stripWrapping(subject);
  const possessive = /^(.*?)['’]s\b/.exec(subject);
  if (possessive?.[1]) subject = stripWrapping(possessive[1]);
  const rollout = /^(?:rollout|status|deployment|work)\s+of\s+(.+)$/i.exec(subject);
  if (rollout?.[1]) subject = stripWrapping(rollout[1]);
  const buildFor = /^(?:production\s+)?(?:build|deployment)\s+for\s+(.+)$/i.exec(subject);
  if (buildFor?.[1]) subject = stripWrapping(buildFor[1]);
  return subject.replace(KIND_SUFFIX, "").trim();
}

function objectPhrase(value: string, type: RetrievalRelationshipType): string {
  let object = value.split(/\b(?:but|while)\b|[;,]/i)[0] ?? value;
  if (type === "USES") object = object.split(/\s+as\s+(?:an?\s+|its\s+|the\s+)/i)[0];
  if (type === "DEPENDS_ON") object = object.split(/\s+for\s+/i)[0];
  if (type === "CREATED_FOR") object = object.split(/\s+from\s+/i)[0];
  object = stripWrapping(object);
  if (type === "OWNS") object = object.replace(/\s+in\s+production\s*$/i, "");
  return object;
}

function objectPhrases(value: string, type: RetrievalRelationshipType): string[] {
  const object = objectPhrase(value, type);
  if (type !== "PROVIDES") return object ? [object] : [];
  return object
    .split(/\s+and\s+/i)
    .map(stripWrapping)
    .filter(Boolean);
}

function inferredType(value: string, preferred: RetrievalEntityType): RetrievalEntityType {
  if (/^project\s+/i.test(value)) return "project";
  if (/\b(?:team|group|department|squad)\b/i.test(value)) return "team";
  if (TECH_HINT.test(value)) return "technology";
  if (LOCATION_HINT.test(value)) return "location";
  if (CHANNEL_HINT.test(value) && preferred === "capability") return "communication_channel";
  return preferred;
}

function codename(sentence: string): { canonical: string; alias: string } | null {
  const typed =
    /\b(?:the\s+)?(.+?)\s+(?:initiative|programme|program|effort)\s+(?:is\s+)?(?:code-?named|codenamed|known\s+as|also\s+called)\s+[`'"“”]?([\p{L}\p{N}][\p{L}\p{N}_.-]*)/iu.exec(
      sentence,
    );
  if (typed?.[1] && typed[2]) {
    return { canonical: stripWrapping(typed[1]), alias: stripWrapping(typed[2]) };
  }
  const parenthetical =
    /\b(project\s+[\p{L}\p{N}_.-]+),?\s+(?:also\s+called|known\s+as)\s+[`'"“”]?([\p{L}\p{N}][\p{L}\p{N}_.-]*)/iu.exec(
      sentence,
    );
  return parenthetical?.[1] && parenthetical[2]
    ? { canonical: stripWrapping(parenthetical[1]), alias: stripWrapping(parenthetical[2]) }
    : null;
}

/**
 * Fast, deterministic NLP extraction for the normal ingestion path. It uses
 * sentence boundaries, explicit enterprise predicates, and conservative noun
 * phrase typing. This is intentionally precision-first: ambiguous prose stays
 * searchable as a chunk instead of becoming an unsafe graph edge.
 */
export class LocalNlpRetrievalExtractor implements RetrievalExtractor {
  readonly id = "local-nlp:v1";

  async extract(input: {
    document: RetrievalSourceDocument;
    chunks: RetrievalChunkInput[];
  }): Promise<RetrievalExtraction> {
    const entities: RetrievalEntityInput[] = [];
    const relationships: RetrievalRelationshipInput[] = [];
    const entityByLabel = new Map<string, RetrievalEntityInput>();
    const relationKeys = new Set<string>();

    const addEntity = (
      name: string,
      type: RetrievalEntityType,
      chunkIndex: number,
      aliases: string[] = [],
    ): RetrievalEntityInput | null => {
      const cleanName = stripWrapping(name);
      const cleanAliases = aliases.map(stripWrapping).filter(Boolean);
      if (!cleanName || cleanName.length > 160) return null;
      const existing = [cleanName, ...cleanAliases]
        .map(normalize)
        .map((label) => entityByLabel.get(label))
        .find(Boolean);
      if (existing) {
        existing.aliases = [...new Set([...(existing.aliases ?? []), ...cleanAliases])];
        if (!existing.mentions.some((mention) => mention.chunkIndex === chunkIndex)) {
          existing.mentions.push({ chunkIndex, confidence: 0.8 });
        }
        for (const label of [cleanName, ...cleanAliases])
          entityByLabel.set(normalize(label), existing);
        return existing;
      }
      const entity: RetrievalEntityInput = {
        key: `nlp:entity-${entities.length}`,
        name: cleanName,
        type,
        aliases: cleanAliases,
        mentions: [{ chunkIndex, confidence: 0.8 }],
      };
      entities.push(entity);
      for (const label of [cleanName, ...cleanAliases]) entityByLabel.set(normalize(label), entity);
      return entity;
    };

    const addRelationship = (
      from: RetrievalEntityInput,
      to: RetrievalEntityInput,
      type: RetrievalRelationshipType,
      fact: string,
      chunkIndex: number,
    ) => {
      if (from.key === to.key) return;
      const signature = `${from.key}|${type}|${to.key}|${chunkIndex}|${fact}`;
      if (relationKeys.has(signature)) return;
      relationKeys.add(signature);
      const relation: RetrievalRelationshipInput = {
        fromKey: from.key,
        toKey: to.key,
        type,
        fact,
        chunkIndex,
        confidence: 0.8,
      };
      relationships.push(relation);
    };

    for (const [chunkIndex, chunk] of input.chunks.entries()) {
      for (const sentence of sentences(chunk.text)) {
        const alias = codename(sentence);
        if (alias) addEntity(alias.canonical, "effort", chunkIndex, [alias.alias]);

        for (const fact of relationClauses(sentence)) {
          if (hasUncertainRetrievalEvidence(fact)) continue;
          const status = STATUS_PATTERN.exec(fact);
          if (status?.index !== undefined && status[1]) {
            const sourceName = subjectPhrase(fact.slice(0, status.index));
            const source =
              entityByLabel.get(normalize(sourceName)) ??
              addEntity(sourceName, inferredType(sourceName, "effort"), chunkIndex);
            const target = addEntity(status[1], "status", chunkIndex);
            if (source && target) addRelationship(source, target, "HAS_STATUS", fact, chunkIndex);
          }

          for (const rule of PREDICATES) {
            const match = rule.pattern.exec(fact);
            if (match?.index === undefined) continue;
            const left = subjectPhrase(fact.slice(0, match.index));
            if (/^(?:he|her|him|it|she|they|them|we|us)$/i.test(left)) continue;
            const rights = objectPhrases(fact.slice(match.index + match[0].length), rule.type);
            if (!left || rights.length === 0) continue;
            for (const right of rights) {
              const fromName = rule.reverse ? right : left;
              const toName = rule.reverse ? left : right;
              const from =
                entityByLabel.get(normalize(fromName)) ??
                addEntity(fromName, inferredType(fromName, rule.fromType), chunkIndex);
              const to =
                entityByLabel.get(normalize(toName)) ??
                addEntity(toName, inferredType(toName, rule.toType), chunkIndex);
              if (from && to) addRelationship(from, to, rule.type, fact, chunkIndex);
            }
          }
        }
      }
    }
    return { entities, relationships };
  }
}
