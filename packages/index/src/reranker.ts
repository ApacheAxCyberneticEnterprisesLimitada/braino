/**
 * Cross-encoder reranking. A bi-encoder embedding model scores query and
 * document independently; a reranker reads the (query, document) pair
 * together, so it resolves the fine distinctions a single cosine score
 * blurs. Across the retrieval literature — and Anthropic's own Contextual
 * Retrieval work — a reranker over the hybrid top-K is the single largest
 * precision@k lever for natural-language queries, which is exactly the
 * shape of agent traffic against a Doco.
 *
 * This module is the building block: a `Reranker` interface plus Cohere and
 * Voyage implementations, mirroring embedding-provider.ts. Reranking is
 * OFF by default — `getDefaultReranker()` returns undefined unless
 * `DOCO_RERANK_PROVIDER` is set — so wiring it in is inert until an operator
 * opts in. The eval harness (scripts/eval-retrieval.mjs) exercises the full
 * embed → cosine → rerank pipeline to quantify the lift before it's wired
 * into the live /search.json path.
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
   * descending relevance. `topN` caps how many are returned (default: all).
   */
  rerank(query: string, documents: string[], topN?: number): Promise<RerankResult[]>;
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

/** Cohere rerank-3.5 (v2 API). Returns `relevance_score` per result. */
export class CohereReranker implements Reranker {
  modelId: string;

  constructor(
    private apiKey: string,
    model = "rerank-v3.5",
  ) {
    assertLatin1ApiKey(apiKey, "COHERE_API_KEY");
    this.modelId = `cohere:${model}`;
  }

  private get model(): string {
    return this.modelId.slice("cohere:".length);
  }

  async rerank(query: string, documents: string[], topN?: number): Promise<RerankResult[]> {
    if (documents.length === 0) return [];
    const res = await fetch("https://api.cohere.com/v2/rerank", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents,
        ...(typeof topN === "number" ? { top_n: topN } : {}),
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Cohere rerank request failed (${res.status}): ${text}`);
    }
    const json = (await res.json()) as {
      results: { index: number; relevance_score: number }[];
    };
    // Cohere returns results already sorted by relevance; normalize the shape.
    return json.results.map((r) => ({ index: r.index, score: r.relevance_score }));
  }
}

/** Voyage rerank-2.5 (v1 API). Returns `relevance_score` per result. */
export class VoyageReranker implements Reranker {
  modelId: string;

  constructor(
    private apiKey: string,
    model = "rerank-2.5",
  ) {
    assertLatin1ApiKey(apiKey, "VOYAGE_API_KEY");
    this.modelId = `voyage:${model}`;
  }

  private get model(): string {
    return this.modelId.slice("voyage:".length);
  }

  async rerank(query: string, documents: string[], topN?: number): Promise<RerankResult[]> {
    if (documents.length === 0) return [];
    const res = await fetch("https://api.voyageai.com/v1/rerank", {
      method: "POST",
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
): Promise<{ item: T; score: number }[]> {
  if (items.length === 0) return [];
  const results = await reranker.rerank(query, items.map(getText), topN);
  return results
    .filter((r) => r.index >= 0 && r.index < items.length)
    .map((r) => ({ item: items[r.index], score: r.score }));
}

/**
 * Resolve the active reranker from the environment, or undefined when
 * reranking is disabled. Unlike embedding selection this does NOT auto-enable
 * on key presence: an operator who set COHERE_API_KEY for embeddings should
 * not silently inherit rerank latency/cost. Opt in explicitly with
 * `DOCO_RERANK_PROVIDER=cohere` | `voyage`.
 */
export function getDefaultReranker(): Reranker | undefined {
  const selector = (process.env.DOCO_RERANK_PROVIDER ?? "").trim().toLowerCase();
  if (!selector || selector === "none" || selector === "noop") return undefined;
  try {
    if (selector === "cohere")
      return rerankerForKey("COHERE_API_KEY", (k) => new CohereReranker(k));
    if (selector === "voyage")
      return rerankerForKey("VOYAGE_API_KEY", (k) => new VoyageReranker(k));
    console.error(
      `[doco/reranker] Unknown DOCO_RERANK_PROVIDER="${selector}"; reranking disabled.`,
    );
    return undefined;
  } catch (e) {
    console.error(`[doco/reranker] ${(e as Error).message}`);
    return undefined;
  }
}

function rerankerForKey(envName: string, make: (key: string) => Reranker): Reranker | undefined {
  const key = process.env[envName];
  if (!key) {
    console.error(
      `[doco/reranker] DOCO_RERANK_PROVIDER selects ${envName} but it is not set; reranking disabled.`,
    );
    return undefined;
  }
  return make(key);
}
