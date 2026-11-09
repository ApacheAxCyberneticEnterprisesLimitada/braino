/**
 * Cross-encoder reranking. A bi-encoder embedding model scores query and
 * document independently; a reranker reads the (query, document) pair
 * together, so it resolves the fine distinctions a single cosine score
 * blurs. Across the retrieval literature — and Anthropic's own Contextual
 * Retrieval work — a reranker over the hybrid top-K is the single largest
 * precision@k lever for natural-language queries, which is exactly the
 * shape of agent traffic against a collection.
 *
 * This module is the building block: a `Reranker` interface and Braino's one
 * Voyage implementation. `VOYAGE_API_KEY` enables it; without the key,
 * reranking is off. The eval harness (scripts/eval-retrieval.mjs) exercises
 * the full embed → cosine → rerank pipeline.
 */
import { assertLatin1ApiKey } from "./embedding-provider.js";

export interface RerankResult {
  /** Index into the `documents` array passed to rerank(). */
  index: number;
  /** Relevance score; higher is better. Scale is provider-specific. */
  score: number;
}

export interface Reranker {
  modelId: string;
  /**
   * Score `documents` against `query` and return results sorted by
   * descending relevance. `topN` caps how many are returned (default: all);
   * `signal` aborts the request (the brief's deadline).
   */
  rerank(
    query: string,
    documents: string[],
    topN?: number,
    signal?: AbortSignal,
  ): Promise<RerankResult[]>;
}

/**
 * Identity reranker: returns documents in their original order with a flat
 * score. Exists for tests and as the explicit "no reranking" object where a
 * non-undefined Reranker is required.
 */
export class NoopReranker implements Reranker {
  modelId = "noop";
  async rerank(_query: string, documents: string[], topN?: number): Promise<RerankResult[]> {
    const out = documents.map((_, index) => ({ index, score: 0 }));
    return typeof topN === "number" ? out.slice(0, topN) : out;
  }
}

/** Voyage rerank-3 (v1 API). Returns `relevance_score` per result. */
export class VoyageReranker implements Reranker {
  modelId: string;

  constructor(
    private apiKey: string,
    model = "rerank-3",
  ) {
    assertLatin1ApiKey(apiKey, "VOYAGE_API_KEY");
    this.modelId = `voyage:${model}`;
  }

  private get model(): string {
    return this.modelId.slice("voyage:".length);
  }

  async rerank(
    query: string,
    documents: string[],
    topN?: number,
    signal?: AbortSignal,
  ): Promise<RerankResult[]> {
    if (documents.length === 0) return [];
    const res = await fetch("https://api.voyageai.com/v1/rerank", {
      method: "POST",
      signal: signal ?? null,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents,
        ...(typeof topN === "number" ? { top_k: topN } : {}),
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Voyage rerank request failed (${res.status}): ${text}`);
    }
    const json = (await res.json()) as {
      data: { index: number; relevance_score: number }[];
    };
    return json.data
      .map((r) => ({ index: r.index, score: r.relevance_score }))
      .sort((a, b) => b.score - a.score);
  }
}

/**
 * Reorder `items` by reranking their `text` against `query`, returning the
 * same item objects in the new order (most relevant first), each paired with
 * its rerank score. Pure over the injected `reranker` — the eval harness and
 * any future search-route wiring share this so the fusion logic lives in one
 * place. Items the reranker doesn't return (beyond `topN`) are dropped.
 */
export async function rerankItems<T>(
  reranker: Reranker,
  query: string,
  items: T[],
  getText: (item: T) => string,
  topN?: number,
  signal?: AbortSignal,
): Promise<{ item: T; score: number }[]> {
  if (items.length === 0) return [];
  const results = await reranker.rerank(query, items.map(getText), topN, signal);
  return results
    .filter((r) => r.index >= 0 && r.index < items.length)
    .map((r) => ({ item: items[r.index], score: r.score }));
}

/** Resolve Braino's Voyage reranker, or undefined when its key is absent. */
export function getDefaultReranker(): Reranker | undefined {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) return undefined;
  try {
    return new VoyageReranker(key);
  } catch (e) {
    console.error(`[collection/reranker] ${(e as Error).message}`);
    return undefined;
  }
}
