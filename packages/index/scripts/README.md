# Retrieval eval harness

## EnterpriseRAG-Bench

`enterprise-rag-bench.mjs` runs Doco's production chunking, embedding, and
multi-path retrieval over the pinned EnterpriseRAG-Bench v1.0.0 exports. It
streams documents directly from the release zip files, preserves each
`dsid_…` identifier for official scoring, resumes an interrupted index, and
writes the benchmark's answer JSONL shape. Use a dedicated database: the
runner refuses ordinary database names.

A complete v1.0.0 run needs the release's `all_documents.zip` and
`questions.jsonl`, a dedicated Postgres database with roughly 40 GB of free
space, `VOYAGE_API_KEY` for Doco's production embeddings, and
`ANTHROPIC_API_KEY` when generating answers. The benchmark's separate official
evaluator also needs its configured judge-model API key.

```sh
DOCO_BENCHMARK_DATABASE_URL='postgresql://localhost/doco_enterpriserag_bench' \
VOYAGE_API_KEY='…' DOCO_EMBEDDING_PROVIDER=voyage \
pnpm --filter @doco/index eval:enterprise-rag -- \
  --archive /path/to/all_documents.zip \
  --questions /path/to/questions.jsonl \
  --output /path/to/doco-enterprise-rag-answers.jsonl \
  --answers
```

`--answers` uses `ANTHROPIC_API_KEY` and Doco's configured assistant model
(`SENOR_DOCO_ANTHROPIC_MODEL`, default `claude-sonnet-4-6`). Omit it for a
retrieval-only run. `--eligible-only` is only for partial-corpus calibration:
it runs questions whose complete gold document set exists in the supplied
archives and must never be reported as the official benchmark score.

The answer file can be passed unchanged to the benchmark's official
`metrics_based_eval` command. A sibling `<output>.summary.json` records the
dataset version, model, corpus counts, retrieval metrics, and latency.

`eval-retrieval.mjs` compares candidate embedding models — and measures the
lift from **asymmetric** query/document hints and from a **reranker** — over a
labeled fixture, so a model choice can be made on measured recall/nDCG rather
than leaderboard rank.

It drives the **real** production modules from `../dist` (the embedding
providers in `embedding-provider.ts`, the reranker in `reranker.ts`, and the
metrics in `retrieval-metrics.ts`). Build the package first:

```sh
pnpm --filter @doco/index build
```

## Run

```sh
# Offline smoke test — deterministic fake provider, no API key, no network:
pnpm --filter @doco/index eval:retrieval

# Run the same labeled fixture through the local Qdrant adapter:
pnpm --filter @doco/index eval:retrieval -- --store qdrant

# Seed local PostgreSQL, backfill those rows, then retrieve from Qdrant:
pnpm --filter @doco/index eval:retrieval -- --store qdrant-backfill

# Compare real models (needs the matching API keys in the env):
OPENAI_API_KEY=… VOYAGE_API_KEY=… COHERE_API_KEY=… \
  pnpm --filter @doco/index eval:retrieval -- --provider openai,voyage,cohere

# Measure the reranker lift (prints a "+rerank" row under each provider):
VOYAGE_API_KEY=… pnpm --filter @doco/index eval:retrieval -- \
  --provider voyage --rerank voyage
```

### Flags

| Flag | Default | Meaning |
|---|---|---|
| `--provider a,b,c` | `fake` | One or more of `fake`, `openai`, `voyage`, `cohere`, `auto`. `auto` uses `getDefaultEmbeddingProvider()`. |
| `--rerank name` | `none` | `none`, `cohere`, `voyage`, or `auto` (`getDefaultReranker()`). Adds a `+rerank` row per provider. |
| `--fixture path` | `eval-fixtures/collection-retrieval.json` | Labeled query/document set. |
| `--ks 1,5,10` | `1,5,10` | Recall cutoffs; nDCG/`+rerank` use the largest. |
| `--rerank-depth N` | `20` | Top-K passed to the reranker. |
| `--store name` | `memory` | `memory`, `pgvector`, `qdrant`, or `qdrant-backfill`; the last mode proves the PostgreSQL-to-Qdrant transition end to end. |
| `--verbose` | off | Print the top-3 retrieved ids per query. |

## Fixture shape

```json
{
  "documents": [{ "id": "...", "type": "...", "text": "..." }],
  "queries":   [{ "query": "...", "relevant": ["id", "..."] }]
}
```

`relevant` may be a list of ids (binary relevance) or an object of
`{ "id": gain }` for graded nDCG (e.g. `2` = perfect, `1` = related).

The committed fixture is built from this repository's real Doco-domain content
(ADRs, the auth flow, workflow rules, the search architecture). Once the collection
handle in `.doco/connections.md` resolves, export real nodes into the same
shape (id, type, prose) and point `--fixture` at them to evaluate on live
content.

## pgvector versus Qdrant

`benchmark-vector-stores.mjs` isolates the vector database. It generates one
deterministic corpus, inserts the exact same normalized vectors into both
engines, applies the same collection filter, and compares each ANN result with
an exact in-memory cosine ranking. It reports ANN recall, labeled-query MRR,
warm-query p50/p75/p95, and ingest/index time.

Start disposable local databases:

```sh
docker run --rm -d --name doco-bench-pgvector \
  -e POSTGRES_PASSWORD=benchmark -p 127.0.0.1:55432:5432 \
  pgvector/pgvector:pg16
docker run --rm -d --name doco-bench-qdrant \
  -p 127.0.0.1:56333:6333 qdrant/qdrant:v1.20.0
```

Then build and run:

```sh
pnpm --filter @doco/index build
pnpm --filter @doco/index benchmark:vector-stores
```

The defaults are 10,000 points, 512 dimensions, 10 labeled queries, two warmup
passes, and ten measured passes. Change them with `--size`, `--dimensions`,
`--queries`, `--k`, `--warmup`, and `--repetitions`; add `--json` for machine-
readable output. Stop the disposable databases when finished:

```sh
docker stop doco-bench-pgvector doco-bench-qdrant
```

## Local application cutover

With `compose.local.yml` running, copy the authoritative local PostgreSQL
embedding rows into Qdrant:

```sh
pnpm --filter @doco/index build
pnpm --filter @doco/index backfill:qdrant
```

Use `--collection collection_…` (repeatable) to limit the copy and
`--batch-size 500` to tune it. The command accepts only localhost URLs. Start
the local web app with `DOCO_VECTOR_STORE=qdrant`; omit that variable to keep
the existing pgvector read path.
