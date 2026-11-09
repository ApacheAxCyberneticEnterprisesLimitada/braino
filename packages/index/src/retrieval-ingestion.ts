// One connector-neutral ingestion path. Connectors fetch and normalize source
// data into RetrievalSourceDocument; this module owns structural chunking,
// extraction, persistence, and embeddings from that point onward.

import {
  type EmbeddingProviderLike,
  type QueryClient,
  type RetrievalChunkInput,
  type RetrievalEntityInput,
  type RetrievalIngestReport,
  type RetrievalRelationshipInput,
  chunkText,
  ingestRetrievalDocument,
} from "@doco/db";
import {
  type RetrievalValidationIssue,
  validateRetrievalExtraction,
} from "./retrieval-ontology.js";

export interface RetrievalSourceDocument {
  collectionId: string;
  source: string;
  externalId: string;
  locator?: string | null;
  title?: string | null;
  content: string;
  accessScopes?: string[];
}

export interface RetrievalExtraction {
  entities: RetrievalEntityInput[];
  relationships: RetrievalRelationshipInput[];
}

export interface RetrievalExtractor {
  /** Changes force already-indexed source documents through extraction again. */
  readonly id: string;
  extract(input: {
    document: RetrievalSourceDocument;
    chunks: RetrievalChunkInput[];
  }): Promise<RetrievalExtraction>;
}

export const GRAPH_ENRICHMENT_MODES = ["fast", "llm-validated"] as const;
export type GraphEnrichmentMode = (typeof GRAPH_ENRICHMENT_MODES)[number];

export interface RetrievalLlmValidator {
  validate(input: {
    document: RetrievalSourceDocument;
    chunks: RetrievalChunkInput[];
    extraction: RetrievalExtraction;
  }): Promise<RetrievalExtraction>;
}

/**
 * Fast, local graph extraction is the zero-cost default. Self-hosters can
 * enable LLM validation instance-wide with an environment variable, while an
 * explicit ingestion option can override it for a workspace or source.
 */
export function resolveGraphEnrichmentMode(
  value: string | undefined = process.env.DOCO_GRAPH_ENRICHMENT_MODE,
): GraphEnrichmentMode {
  const normalized = value?.trim().toLowerCase() || "fast";
  if (normalized === "fast" || normalized === "llm-validated") return normalized;
  throw new Error(
    `DOCO_GRAPH_ENRICHMENT_MODE must be "fast" or "llm-validated"; received ${JSON.stringify(value)}`,
  );
}

export interface RetrievalChunkingOptions {
  maxChars?: number;
  overlapChars?: number;
}

export interface RetrievalSourceIngestReport extends RetrievalIngestReport {
  validation: {
    mode: GraphEnrichmentMode;
    llmApplied: boolean;
    acceptedEntities: number;
    rejectedEntities: number;
    acceptedRelationships: number;
    rejectedRelationships: number;
    issues: RetrievalValidationIssue[];
  };
}

/**
 * Preserve Markdown heading context while using Braino's existing overlap-aware
 * text chunker inside each section. Slack/plain-text documents naturally take
 * the single-section path.
 */
export function chunkRetrievalSource(
  document: RetrievalSourceDocument,
  options: RetrievalChunkingOptions = {},
): RetrievalChunkInput[] {
  const lines = document.content.replace(/\r\n?/g, "\n").split("\n");
  const headings: string[] = [];
  const chunks: RetrievalChunkInput[] = [];
  let section: string[] = [];

  const flush = () => {
    const text = section.join("\n").trim();
    section = [];
    if (!text) return;
    const breadcrumb = [document.title?.trim(), ...headings].filter(Boolean).join(" > ") || null;
    for (const part of chunkText(text, options)) chunks.push({ text: part, breadcrumb });
  };

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) {
      section.push(line);
      continue;
    }
    flush();
    const level = match[1].length;
    headings.splice(level - 1);
    headings[level - 1] = match[2].trim();
  }
  flush();

  // A title-only page or a document containing headings without body text is
  // still useful evidence. Index its structural path instead of dropping it.
  if (chunks.length === 0) {
    const breadcrumb = [document.title?.trim(), ...headings].filter(Boolean).join(" > ");
    if (breadcrumb) chunks.push({ text: breadcrumb, breadcrumb: null });
  }
  if (chunks.length === 0) throw new Error("Retrieval source document has no indexable text");
  return chunks;
}

/**
 * The only ingestion entry point connectors need after fetching their source.
 * Extraction is injected so local tests can be deterministic and production
 * can later use a small model without coupling connectors to that model.
 */
export async function ingestRetrievalSource(
  c: QueryClient,
  document: RetrievalSourceDocument,
  options: {
    extractor: RetrievalExtractor;
    llmValidator?: RetrievalLlmValidator;
    graphEnrichmentMode?: GraphEnrichmentMode;
    embeddingProvider?: EmbeddingProviderLike;
    chunking?: RetrievalChunkingOptions;
  },
): Promise<RetrievalSourceIngestReport> {
  const mode = options.graphEnrichmentMode ?? resolveGraphEnrichmentMode();
  const llmValidator = mode === "llm-validated" ? options.llmValidator : undefined;
  if (mode === "llm-validated" && !llmValidator) {
    throw new Error('Graph enrichment mode "llm-validated" requires an llmValidator');
  }
  const chunks = chunkRetrievalSource(document, options.chunking);
  const extracted = await options.extractor.extract({ document, chunks });
  const extraction = llmValidator
    ? await llmValidator.validate({ document, chunks, extraction: extracted })
    : extracted;
  const validated = validateRetrievalExtraction(document, chunks, extraction);
  const report = await ingestRetrievalDocument(
    c,
    { ...document, chunks, extraction: validated.extraction },
    options.embeddingProvider ? { embeddingProvider: options.embeddingProvider } : {},
  );
  return {
    ...report,
    validation: {
      mode,
      llmApplied: Boolean(llmValidator),
      acceptedEntities: validated.extraction.entities.length,
      rejectedEntities: extraction.entities.length - validated.extraction.entities.length,
      acceptedRelationships: validated.extraction.relationships.length,
      rejectedRelationships:
        extraction.relationships.length - validated.extraction.relationships.length,
      issues: validated.issues,
    },
  };
}
