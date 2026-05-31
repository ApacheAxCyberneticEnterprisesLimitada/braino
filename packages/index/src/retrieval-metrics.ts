/**
 * Pure retrieval-quality metrics. No I/O, no provider calls — just ranked id
 * lists and relevance judgments in, numbers out — so they're cheap to unit
 * test deterministically and reusable by the eval harness
 * (scripts/eval-retrieval.mjs) and any future in-app A/B.
 *
 * Relevance can be binary (a Set of relevant ids) or graded (a Map from id to
 * a non-negative gain, e.g. 2 = perfect, 1 = related). nDCG uses the graded
 * gains directly; recall/precision/MRR treat any positive gain as relevant.
 */

export type Relevance = Set<string> | Map<string, number>;

function gainOf(relevance: Relevance, id: string): number {
  if (relevance instanceof Set) return relevance.has(id) ? 1 : 0;
  return relevance.get(id) ?? 0;
}

function relevantCount(relevance: Relevance): number {
  if (relevance instanceof Set) return relevance.size;
  let n = 0;
  for (const g of relevance.values()) if (g > 0) n++;
  return n;
}

/** Fraction of all relevant items that appear in the top-k of `ranked`. */
export function recallAtK(ranked: string[], relevance: Relevance, k: number): number {
  const total = relevantCount(relevance);
  if (total === 0) return 0;
  let hit = 0;
  for (const id of ranked.slice(0, k)) if (gainOf(relevance, id) > 0) hit++;
  return hit / total;
}

/** Fraction of the top-k that are relevant. */
export function precisionAtK(ranked: string[], relevance: Relevance, k: number): number {
  if (k <= 0) return 0;
  const window = ranked.slice(0, k);
  if (window.length === 0) return 0;
  let hit = 0;
  for (const id of window) if (gainOf(relevance, id) > 0) hit++;
  return hit / window.length;
}

/**
 * Reciprocal rank of the first relevant hit (1/rank), or 0 if none. Average
 * over a query set to get MRR.
 */
export function reciprocalRank(ranked: string[], relevance: Relevance): number {
  for (let i = 0; i < ranked.length; i++) {
    if (gainOf(relevance, ranked[i]) > 0) return 1 / (i + 1);
  }
  return 0;
}

function dcgAtK(gains: number[], k: number): number {
  let dcg = 0;
  const upto = Math.min(k, gains.length);
  for (let i = 0; i < upto; i++) {
    // Standard log2(rank+1) discount with rank starting at 1.
    dcg += gains[i] / Math.log2(i + 2);
  }
  return dcg;
}

/**
 * Normalized DCG at k. Ideal ordering is the relevant gains sorted
 * descending; nDCG = DCG(ranked) / DCG(ideal), in [0, 1]. Returns 0 when no
 * item carries positive gain.
 */
export function nDCGAtK(ranked: string[], relevance: Relevance, k: number): number {
  const gains = ranked.map((id) => gainOf(relevance, id));
  const idealGains =
    relevance instanceof Set
      ? Array.from({ length: relevance.size }, () => 1)
      : Array.from(relevance.values())
          .filter((g) => g > 0)
          .sort((a, b) => b - a);
  const idcg = dcgAtK(idealGains, k);
  if (idcg === 0) return 0;
  return dcgAtK(gains, k) / idcg;
}

export interface QueryEvaluation {
  query: string;
  ranked: string[];
  relevance: Relevance;
}

export interface RetrievalReport {
  queries: number;
  ks: number[];
  recall: Record<number, number>;
  precision: Record<number, number>;
  ndcg: Record<number, number>;
  mrr: number;
}

/**
 * Macro-average the metrics over a set of queries at the requested cutoffs.
 * "Macro" = mean of per-query scores (each query weighted equally), the
 * conventional choice for retrieval eval.
 */
export function evaluateRetrieval(
  evals: QueryEvaluation[],
  ks: number[] = [1, 5, 10],
): RetrievalReport {
  const recall: Record<number, number> = {};
  const precision: Record<number, number> = {};
  const ndcg: Record<number, number> = {};
  for (const k of ks) {
    recall[k] = 0;
    precision[k] = 0;
    ndcg[k] = 0;
  }
  let mrr = 0;
  const n = evals.length || 1;
  for (const e of evals) {
    for (const k of ks) {
      recall[k] += recallAtK(e.ranked, e.relevance, k);
      precision[k] += precisionAtK(e.ranked, e.relevance, k);
      ndcg[k] += nDCGAtK(e.ranked, e.relevance, k);
    }
    mrr += reciprocalRank(e.ranked, e.relevance);
  }
  for (const k of ks) {
    recall[k] /= n;
    precision[k] /= n;
    ndcg[k] /= n;
  }
  return { queries: evals.length, ks, recall, precision, ndcg, mrr: mrr / n };
}
