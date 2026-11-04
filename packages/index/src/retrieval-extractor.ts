import {
  DEFAULT_GEMINI_RETRIEVAL_TIMEOUT_MS,
  GeminiRetrievalExtractor,
} from "./gemini-retrieval-extractor.js";
import { LocalNlpRetrievalExtractor } from "./local-nlp-retrieval-extractor.js";
import type { RetrievalExtractor } from "./retrieval-ingestion.js";

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

/** Gemini upgrades extraction when OpenRouter is configured; local NLP is the no-key default. */
export function configuredRetrievalExtractor(
  env: Record<string, string | undefined> = process.env,
): RetrievalExtractor {
  const apiToken = env.OPENROUTER_API_KEY?.trim();
  if (!apiToken) return new LocalNlpRetrievalExtractor();
  return new GeminiRetrievalExtractor({
    apiToken,
    timeoutMs: parsePositiveInteger(
      env.DOCO_RETRIEVAL_EXTRACTION_TIMEOUT_MS,
      DEFAULT_GEMINI_RETRIEVAL_TIMEOUT_MS,
      "DOCO_RETRIEVAL_EXTRACTION_TIMEOUT_MS",
    ),
  });
}
