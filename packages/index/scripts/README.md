# Retrieval eval harness

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
| `--fixture path` | `eval-fixtures/doco-retrieval.json` | Labeled query/document set. |
| `--ks 1,5,10` | `1,5,10` | Recall cutoffs; nDCG/`+rerank` use the largest. |
| `--rerank-depth N` | `20` | Top-K passed to the reranker. |
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
(ADRs, the auth flow, workflow rules, the search architecture). Once the Doco
handle in `.doco/connections.md` resolves, export real nodes into the same
shape (id, type, prose) and point `--fixture` at them to evaluate on live
content.
