import { LocalNlpRetrievalExtractor } from "./local-nlp-retrieval-extractor.js";
import {
  DEFAULT_OLLAMA_GRAPH_URL,
  OllamaRetrievalExtractor,
} from "./ollama-retrieval-extractor.js";
import type { RetrievalExtractor } from "./retrieval-ingestion.js";

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

/** A configured generative model upgrades extraction; otherwise fast local NLP is the default. */
export function configuredRetrievalExtractor(
  env: Record<string, string | undefined> = process.env,
): RetrievalExtractor {
  const model = env.DOCO_RETRIEVAL_EXTRACTION_MODEL?.trim();
  if (!model) return new LocalNlpRetrievalExtractor();
  return new OllamaRetrievalExtractor({
    model,
    url: env.DOCO_RETRIEVAL_EXTRACTION_URL?.trim() || DEFAULT_OLLAMA_GRAPH_URL,
    ...(env.DOCO_RETRIEVAL_EXTRACTION_API_TOKEN
      ? { apiToken: env.DOCO_RETRIEVAL_EXTRACTION_API_TOKEN }
      : {}),
    timeoutMs: parsePositiveInteger(
      env.DOCO_RETRIEVAL_EXTRACTION_TIMEOUT_MS,
      120_000,
      "DOCO_RETRIEVAL_EXTRACTION_TIMEOUT_MS",
    ),
  });
}
