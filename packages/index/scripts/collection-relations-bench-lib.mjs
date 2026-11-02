import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COLLECTION_RELATIONSHIP_TYPES } from "../dist/collection-relationship-validation.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const RELATIONSHIP_TYPE_SET = new Set(COLLECTION_RELATIONSHIP_TYPES);

function positiveInteger(value, flag, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function batchSizes(value) {
  const sizes = value.split(",").map((part) => positiveInteger(part.trim(), "--batch-sizes"));
  if (sizes.length === 0 || sizes.some((size, index) => index > 0 && size <= sizes[index - 1])) {
    throw new Error("--batch-sizes must be strictly increasing positive integers");
  }
  return sizes;
}

export function parseCollectionRelationsArgs(argv, env = process.env) {
  const parsed = {
    fixture: resolve(HERE, "eval-fixtures/collection-relations.json"),
    output: resolve("collection-relations-benchmark.json"),
    model: env.DOCO_GRAPH_EXTRACTION_MODEL?.trim() || "qwen3:8b",
    url: env.DOCO_GRAPH_EXTRACTION_URL?.trim() || "http://127.0.0.1:11434/api/chat",
    apiToken: env.DOCO_GRAPH_EXTRACTION_API_TOKEN?.trim() || "",
    anchor: "",
    batchSizes: [8, 16, 24, 32],
    numCtx: 8192,
    repeats: 1,
    timeoutMs: 180_000,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") continue;
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--fixture") parsed.fixture = resolve(next());
    else if (arg === "--output") parsed.output = resolve(next());
    else if (arg === "--model") parsed.model = next();
    else if (arg === "--url") parsed.url = next();
    else if (arg === "--anchor") parsed.anchor = next();
    else if (arg === "--batch-sizes") parsed.batchSizes = batchSizes(next());
    else if (arg === "--num-ctx") {
      parsed.numCtx = positiveInteger(next(), "--num-ctx", { min: 2048, max: 65_536 });
    } else if (arg === "--repeats") {
      parsed.repeats = positiveInteger(next(), "--repeats", { min: 1, max: 10 });
    } else if (arg === "--timeout-ms") {
      parsed.timeoutMs = positiveInteger(next(), "--timeout-ms", { min: 1_000, max: 900_000 });
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!parsed.model.trim()) throw new Error("--model cannot be blank");
  if (!parsed.anchor.trim() && argv.includes("--anchor")) {
    throw new Error("--anchor cannot be blank");
  }
  return parsed;
}

export function validateCollectionRelationsFixture(fixture) {
  if (!fixture || !Array.isArray(fixture.collections) || fixture.collections.length === 0) {
    throw new Error("Collection relationship fixture requires collections");
  }
  if (!Array.isArray(fixture.relationships)) {
    throw new Error("Collection relationship fixture requires relationships");
  }
  const ids = new Set();
  for (const collection of fixture.collections) {
    if (
      !collection ||
      typeof collection.collectionId !== "string" ||
      !collection.collectionId.trim() ||
      typeof collection.name !== "string" ||
      !collection.name.trim() ||
      typeof collection.digest !== "string" ||
      !collection.digest.trim() ||
      typeof collection.summaryVersion !== "string" ||
      !collection.summaryVersion.trim() ||
      !Array.isArray(collection.evidenceIds) ||
      collection.evidenceIds.length === 0 ||
      !collection.evidenceIds.every((id) => typeof id === "string" && id.trim())
    ) {
      throw new Error(
        "Every benchmark collection needs collectionId, name, digest, summaryVersion, and evidenceIds",
      );
    }
    if (ids.has(collection.collectionId)) {
      throw new Error(`Duplicate collection id: ${collection.collectionId}`);
    }
    ids.add(collection.collectionId);
  }
  const edges = new Set();
  for (const relationship of fixture.relationships) {
    if (!ids.has(relationship?.from) || !ids.has(relationship?.to)) {
      throw new Error("Gold relationship references an unknown collection");
    }
    if (relationship.from === relationship.to) {
      throw new Error("Gold relationship cannot connect a collection to itself");
    }
    if (!RELATIONSHIP_TYPE_SET.has(relationship.type)) {
      throw new Error(`Unknown gold relationship type: ${relationship.type}`);
    }
    const key = relationshipKey(relationship);
    if (edges.has(key)) throw new Error(`Duplicate gold relationship: ${key}`);
    edges.add(key);
  }
  return fixture;
}

function relationshipKey(relationship) {
  return `${relationship.from}\u0000${relationship.type}\u0000${relationship.to}`;
}

function endpointPairKey(relationship) {
  return [relationship.from, relationship.to].sort().join("\u0000");
}

export function visibleBenchmarkFixture(fixture, size, anchor = "") {
  if (!Number.isInteger(size) || size < 1) throw new Error("batch size must be a positive integer");
  const collections = fixture.collections.slice(0, size);
  const ids = new Set(collections.map((collection) => collection.collectionId));
  if (anchor && !ids.has(anchor)) {
    throw new Error(`Anchor collection ${anchor} is not visible in batch ${size}`);
  }
  return {
    collections,
    relationships: fixture.relationships.filter(
      (relationship) =>
        ids.has(relationship.from) &&
        ids.has(relationship.to) &&
        (!anchor || relationship.from === anchor || relationship.to === anchor),
    ),
  };
}
function evidenceSupports(prediction, collectionById) {
  if (!prediction || !Array.isArray(prediction.evidence)) return false;
  for (const endpoint of [prediction.from, prediction.to]) {
    const collection = collectionById.get(endpoint);
    if (!collection) return false;
    const allowed = new Set(collection.evidenceIds);
    const cited = prediction.evidence
      .filter(
        (item) =>
          item?.collectionId === endpoint &&
          item.summaryVersion === collection.summaryVersion &&
          Array.isArray(item.evidenceIds),
      )
      .flatMap((item) => item.evidenceIds);
    if (!cited.some((id) => allowed.has(id))) return false;
  }
  return true;
}

export function scoreCollectionRelationships(fixture, predictions) {
  const collectionById = new Map(
    fixture.collections.map((collection) => [collection.collectionId, collection]),
  );
  const goldByKey = new Set(fixture.relationships.map(relationshipKey));
  const goldByPair = new Map(
    fixture.relationships.map((relationship) => [endpointPairKey(relationship), relationship]),
  );
  const predicted = Array.isArray(predictions) ? predictions : [];
  const validPredictions = predicted.filter(
    (relationship) =>
      collectionById.has(relationship?.from) &&
      collectionById.has(relationship?.to) &&
      relationship.from !== relationship.to &&
      RELATIONSHIP_TYPE_SET.has(relationship?.type),
  );
  const invalidEdges = predicted.length - validPredictions.length;
  const exactTruePositives = new Set(
    validPredictions.map(relationshipKey).filter((key) => goldByKey.has(key)),
  ).size;
  const gold = fixture.relationships.length;
  const precision =
    predicted.length === 0 ? (gold === 0 ? 1 : 0) : exactTruePositives / predicted.length;
  const recall = gold === 0 ? 1 : exactTruePositives / gold;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  let endpointMatches = 0;
  let correctType = 0;
  let correctDirection = 0;
  for (const goldRelationship of fixture.relationships) {
    const candidates = validPredictions.filter(
      (prediction) => endpointPairKey(prediction) === endpointPairKey(goldRelationship),
    );
    if (candidates.length === 0) continue;
    endpointMatches++;
    if (candidates.some((prediction) => prediction.type === goldRelationship.type)) correctType++;
    if (
      candidates.some(
        (prediction) =>
          prediction.from === goldRelationship.from && prediction.to === goldRelationship.to,
      )
    ) {
      correctDirection++;
    }
  }
  const unsupportedEdges = predicted.filter(
    (prediction) => !evidenceSupports(prediction, collectionById),
  ).length;

  return {
    gold,
    predicted: predicted.length,
    exactTruePositives,
    precision,
    recall,
    f1,
    endpointPairRecall: gold === 0 ? 1 : endpointMatches / goldByPair.size,
    typeAccuracy: endpointMatches === 0 ? (gold === 0 ? 1 : 0) : correctType / endpointMatches,
    directionAccuracy:
      endpointMatches === 0 ? (gold === 0 ? 1 : 0) : correctDirection / endpointMatches,
    unsupportedEdges,
    unsupportedRate: predicted.length === 0 ? 0 : unsupportedEdges / predicted.length,
    invalidEdges,
  };
}
