#!/usr/bin/env node
// Retrieval eval harness. Drives the REAL production modules from ../dist
// (the embedding providers, the reranker, and the retrieval metrics) over a
// labeled fixture so we can compare candidate embedding models — and measure
// the lift from asymmetric query/document hints and from reranking — BEFORE
// committing to one in production.
//
// Zero runtime deps: it imports the built @doco/index barrel and otherwise
// uses only Node built-ins. Build the package first:
//
//   pnpm --filter @doco/index build
//
// Usage:
//   node scripts/eval-retrieval.mjs                       # fake provider, fixture
//   node scripts/eval-retrieval.mjs --provider fake,openai,voyage,cohere
//   node scripts/eval-retrieval.mjs --store qdrant
//   node scripts/eval-retrieval.mjs --store qdrant-backfill
//   node scripts/eval-retrieval.mjs --store postgres-fts
//   node scripts/eval-retrieval.mjs --store qdrant-bm25
//   node scripts/eval-retrieval.mjs --store qdrant-hybrid
//   node scripts/eval-retrieval.mjs --provider voyage --rerank voyage
//   node scripts/eval-retrieval.mjs --fixture path/to.json --ks 1,3,10 --verbose
//
// Providers other than `fake` require the matching API key in the env
// (OPENAI_API_KEY / VOYAGE_API_KEY / COHERE_API_KEY). The `fake` provider is
// a deterministic bag-of-words hash — no network — so the harness (and the
// metrics it reports) runs anywhere, including CI.
//
// Fixture shape (see scripts/eval-fixtures/collection-retrieval.json):
//   { "documents": [ { "id": "...", "type": "...", "text": "..." } ],
//     "queries":   [ { "query": "...", "relevant": ["id", ...] } ] }
// `relevant` may also be an object of { id: gain } for graded nDCG.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist", "index.js");
const QDRANT_DIST = join(HERE, "..", "dist", "qdrant-vector-store.js");
const QDRANT_BACKFILL_DIST = join(HERE, "..", "dist", "qdrant-backfill.js");
const EVAL_WORKSPACE = "workspace_retrieval_eval";
const EVAL_COLLECTION = "collection_retrieval_eval";
const EVAL_QDRANT_COLLECTION = "doco_retrieval_eval";

let mod;
try {
  mod = await import(DIST);
} catch {
  console.error(
    `Could not import ${DIST}\nBuild the package first:  pnpm --filter @doco/index build`,
  );
  process.exit(1);
}

const {
  OpenAIEmbeddingProvider,
  VoyageEmbeddingProvider,
  CohereEmbeddingProvider,
  getDefaultEmbeddingProvider,
  CohereReranker,
  VoyageReranker,
  getDefaultReranker,
  rerankItems,
  evaluateRetrieval,
} = mod;
const { QdrantVectorStore } = await import(QDRANT_DIST);
const { backfillEmbeddingsToVectorStore } = await import(QDRANT_BACKFILL_DIST);

// ---- CLI ------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    providers: ["fake"],
    rerank: "none",
    fixture: join(HERE, "eval-fixtures", "collection-retrieval.json"),
    ks: [1, 5, 10],
    rerankDepth: 20,
    store: "memory",
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--") continue;
    if (a === "--provider" || a === "--providers") opts.providers = next().split(",");
    else if (a === "--rerank") opts.rerank = next();
    else if (a === "--fixture") opts.fixture = resolve(next());
    else if (a === "--ks") opts.ks = next().split(",").map(Number);
    else if (a === "--rerank-depth") opts.rerankDepth = Number(next());
    else if (a === "--store") opts.store = next();
    else if (a === "--verbose") opts.verbose = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return opts;
}

function reqEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name} in the environment for the selected provider.`);
    process.exit(1);
  }
  return v;
}

// ---- Fake provider + cosine (the only non-production bits) ----------------

// Deterministic bag-of-words hash embedding. Lexical, not semantic, but
// stable and offline — enough to exercise the full pipeline and prove the
// metrics. Real models are selected with --provider.
class FakeEmbeddingProvider {
  modelId = "fake:bow-hash-256";
  dimensions = 256;
  async embed(texts) {
    return texts.map((t) => hashEmbed(t, this.dimensions));
  }
}

function hashEmbed(text, dims) {
  const v = new Float32Array(dims);
  const tokens =
    String(text)
      .toLowerCase()
      .match(/[a-z0-9]+/g) || [];
  for (const tok of tokens) {
    let h = 5381;
    for (let i = 0; i < tok.length; i++) h = (Math.imul(h, 33) + tok.charCodeAt(i)) | 0;
    v[Math.abs(h) % dims] += 1;
  }
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i++) v[i] /= norm;
  return v;
}

function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function makeProvider(name) {
  switch (name) {
    case "fake":
      return new FakeEmbeddingProvider();
    case "openai":
      return new OpenAIEmbeddingProvider(reqEnv("OPENAI_API_KEY"));
    case "voyage":
      return new VoyageEmbeddingProvider(
        reqEnv("VOYAGE_API_KEY"),
        process.env.DOCO_VOYAGE_EMBEDDING_MODEL?.trim() || undefined,
      );
    case "cohere":
      return new CohereEmbeddingProvider(reqEnv("COHERE_API_KEY"));
    case "auto":
      return getDefaultEmbeddingProvider();
    default:
      console.error(`Unknown provider: ${name} (use fake|openai|voyage|cohere|auto)`);
      process.exit(1);
  }
}

function makeReranker(name) {
  if (!name || name === "none") return undefined;
  if (name === "cohere") return new CohereReranker(reqEnv("COHERE_API_KEY"));
  if (name === "voyage") return new VoyageReranker(reqEnv("VOYAGE_API_KEY"));
  if (name === "auto") return getDefaultReranker();
  console.error(`Unknown reranker: ${name} (use none|cohere|voyage|auto)`);
  process.exit(1);
}

function toRelevance(relevant) {
  if (Array.isArray(relevant)) return new Set(relevant);
  return new Map(Object.entries(relevant));
}

// ---- Pipeline -------------------------------------------------------------

async function rankWithProvider(provider, documents, queries) {
  // Embed the corpus once as documents; embed each query as a query.
  const docVecs = await provider.embed(
    documents.map((d) => d.text),
    "document",
  );
  const evals = [];
  for (const q of queries) {
    const [qv] = await provider.embed([q.query], "query");
    const scored = documents
      .map((d, i) => ({ id: d.id, score: cosine(qv, docVecs[i]) }))
      .sort((a, b) => b.score - a.score);
    evals.push({
      query: q.query,
      ranked: scored.map((s) => s.id),
      relevance: toRelevance(q.relevant),
    });
  }
  return evals;
}

async function rankWithVectorStore(store, provider, documents, queries, mode = "dense") {
  const docVecs = await provider.embed(
    documents.map((d) => d.text),
    "document",
  );
  await store.upsert(
    documents.map((document, index) => ({
      collection_id: EVAL_COLLECTION,
      source: "node",
      entity_id: document.id,
      chunk_index: 0,
      model_id: provider.modelId,
      content_hash: `${provider.modelId}:${document.id}`,
      chunk_text: document.text,
      embedding: docVecs[index],
    })),
  );

  const evals = [];
  for (const q of queries) {
    const common = {
      collectionIds: [EVAL_COLLECTION],
      source: "node",
      limit: documents.length,
    };
    let hits;
    if (mode === "bm25") {
      hits = await store.rankLexical({ ...common, queryText: q.query });
    } else {
      const [queryEmbedding] = await provider.embed([q.query], "query");
      const dense = {
        ...common,
        modelId: provider.modelId,
        queryEmbedding,
      };
      hits =
        mode === "hybrid"
          ? await store.rankHybrid({
              ...dense,
              queryText: q.query,
              prefetchLimit: documents.length,
            })
          : await store.rank(dense);
    }
    evals.push({
      query: q.query,
      ranked: hits.map((hit) => hit.entity_id),
      relevance: toRelevance(q.relevant),
    });
  }
  return evals;
}

async function rankWithPostgresFts(documents, queries) {
  requireLocalDatabase();
  const { closePool, ensureSchema, ingestRetrievalDocument, searchRetrievalChunksFts, withClient } =
    await import("@doco/db");
  await ensureSchema();
  try {
    return await withClient(async (client) => {
      await client.query(
        `INSERT INTO workspaces (id, handle, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO NOTHING`,
        [EVAL_WORKSPACE, "retrieval-eval", "Retrieval eval"],
      );
      await client.query("DELETE FROM collections WHERE id = $1", [EVAL_COLLECTION]);
      await client.query(
        `INSERT INTO collections (id, handle, owner_id, workspace_id, data)
         VALUES ($1, $2, $3, $3, '{}'::jsonb)`,
        [EVAL_COLLECTION, "retrieval-eval-corpus", EVAL_WORKSPACE],
      );
      for (const document of documents) {
        await ingestRetrievalDocument(client, {
          collectionId: EVAL_COLLECTION,
          source: "eval",
          externalId: document.id,
          title: document.id,
          content: document.text,
          accessScopes: ["workspace"],
          chunks: [{ text: document.text }],
          extraction: { entities: [], relationships: [] },
        });
      }

      const evals = [];
      for (const query of queries) {
        const hits = await searchRetrievalChunksFts(client, {
          collectionId: EVAL_COLLECTION,
          queryText: query.query,
          accessScopes: ["workspace"],
          limit: documents.length,
        });
        evals.push({
          query: query.query,
          ranked: hits.map((hit) => hit.external_id),
          relevance: toRelevance(query.relevant),
        });
      }
      await client.query("DELETE FROM collections WHERE id = $1", [EVAL_COLLECTION]);
      return evals;
    });
  } finally {
    await closePool();
  }
}

function requireLocalDatabase() {
  const databaseUrl =
    process.env.DOCO_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgresql://doco:doco-local@127.0.0.1:55432/doco";
  const host = new URL(databaseUrl).hostname;
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
    throw new Error("Database-backed retrieval evals accept only a localhost DATABASE_URL.");
  }
  process.env.DOCO_DATABASE_URL = databaseUrl;
}

function localQdrantUrl() {
  const qdrantUrl = process.env.QDRANT_URL ?? "http://127.0.0.1:6333";
  const host = new URL(qdrantUrl).hostname;
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
    throw new Error("BM25 and hybrid retrieval evals accept only a localhost QDRANT_URL.");
  }
  return qdrantUrl;
}

async function rankThroughPostgresThenQdrant(provider, documents, queries, qdrantStore) {
  requireLocalDatabase();
  const { closePool, ensureSchema, upsertEmbeddings, withClient } = await import("@doco/db");
  await ensureSchema();
  try {
    return await withClient(async (client) => {
      await client.query(
        `INSERT INTO workspaces (id, handle, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO NOTHING`,
        [EVAL_WORKSPACE, "retrieval-eval", "Retrieval eval"],
      );
      await client.query("DELETE FROM collections WHERE id = $1", [EVAL_COLLECTION]);
      await client.query(
        `INSERT INTO collections (id, handle, owner_id, workspace_id, data)
         VALUES ($1, $2, $3, $3, '{}'::jsonb)`,
        [EVAL_COLLECTION, "retrieval-eval-corpus", EVAL_WORKSPACE],
      );
      await upsertEmbeddings(
        client,
        documents.map((document) => ({
          collection_id: EVAL_COLLECTION,
          source: "node",
          entity_id: document.id,
          chunks: [document.text],
        })),
        provider,
        { pruneStale: true },
      );
      await qdrantStore.delete({ collectionIds: [EVAL_COLLECTION] });
      await backfillEmbeddingsToVectorStore(client, qdrantStore, {
        collectionIds: [EVAL_COLLECTION],
      });

      const evals = [];
      for (const q of queries) {
        const [queryEmbedding] = await provider.embed([q.query], "query");
        const rankArgs = {
          collectionIds: [EVAL_COLLECTION],
          source: "node",
          modelId: provider.modelId,
          queryEmbedding,
          limit: documents.length,
        };
        const hits = await qdrantStore.rank(rankArgs);
        evals.push({
          query: q.query,
          ranked: hits.map((hit) => hit.entity_id),
          relevance: toRelevance(q.relevant),
        });
      }
      await client.query("DELETE FROM collections WHERE id = $1", [EVAL_COLLECTION]);
      return evals;
    });
  } finally {
    await closePool();
  }
}

async function applyRerank(reranker, provider, documents, queries, depth) {
  const docById = new Map(documents.map((d) => [d.id, d]));
  const docVecs = await provider.embed(
    documents.map((d) => d.text),
    "document",
  );
  const evals = [];
  for (const q of queries) {
    const [qv] = await provider.embed([q.query], "query");
    const scored = documents
      .map((d, i) => ({ id: d.id, score: cosine(qv, docVecs[i]) }))
      .sort((a, b) => b.score - a.score);
    const head = scored.slice(0, depth).map((s) => ({ id: s.id, text: docById.get(s.id).text }));
    const reranked = await rerankItems(reranker, q.query, head, (it) => it.text, depth);
    const seen = new Set(reranked.map((r) => r.item.id));
    const ranked = [
      ...reranked.map((r) => r.item.id),
      ...scored.map((s) => s.id).filter((id) => !seen.has(id)),
    ];
    evals.push({ query: q.query, ranked, relevance: toRelevance(q.relevant) });
  }
  return evals;
}

function pad(value, n) {
  const s = String(value);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

function printReportRow(label, report, ks) {
  const cells = [
    pad(label, 34),
    ...ks.map((k) => pad(pct(report.recall[k]), 11)),
    pad(report.ndcg[ks[ks.length - 1]].toFixed(3), 10),
    pad(report.mrr.toFixed(3), 7),
  ];
  console.log(cells.join(""));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const fixture = JSON.parse(readFileSync(opts.fixture, "utf8"));
  const { documents, queries } = fixture;
  const reranker = makeReranker(opts.rerank);
  const stores = new Set([
    "memory",
    "postgres-fts",
    "qdrant",
    "qdrant-backfill",
    "qdrant-bm25",
    "qdrant-hybrid",
  ]);
  if (!stores.has(opts.store)) {
    throw new Error(`Unknown store: ${opts.store} (use ${[...stores].join("|")})`);
  }
  if (opts.store !== "memory" && reranker) {
    throw new Error("Storage evals isolate retrieval; run reranker evals with --store memory.");
  }
  const qdrantTextSearch = opts.store === "qdrant-bm25" || opts.store === "qdrant-hybrid";
  const vectorStore = opts.store.startsWith("qdrant")
    ? new QdrantVectorStore({
        url: qdrantTextSearch
          ? localQdrantUrl()
          : (process.env.QDRANT_URL ?? "http://127.0.0.1:6333"),
        apiKey: process.env.QDRANT_API_KEY,
        ...(qdrantTextSearch ? { collection: EVAL_QDRANT_COLLECTION, enableTextSearch: true } : {}),
      })
    : undefined;

  const rerankLine = reranker ? `\nReranker: ${reranker.modelId} (depth ${opts.rerankDepth})` : "";
  console.log(
    `\nFixture: ${opts.fixture}\nStore: ${opts.store}\n${documents.length} documents, ${queries.length} queries, cutoffs k=${opts.ks.join("/")}${rerankLine}`,
  );
  console.log("");
  const header = [
    pad("provider / config", 34),
    ...opts.ks.map((k) => pad(`recall@${k}`, 11)),
    pad(`nDCG@${opts.ks[opts.ks.length - 1]}`, 10),
    pad("MRR", 7),
  ].join("");
  console.log(header);
  console.log("-".repeat(header.length));

  if (opts.store === "postgres-fts") {
    const evals = await rankWithPostgresFts(documents, queries);
    printReportRow("postgres:fts", evaluateRetrieval(evals, opts.ks), opts.ks);
    if (opts.verbose) {
      for (const e of evals) {
        console.log(`    "${e.query}" → ${e.ranked.slice(0, 3).join(", ")}`);
      }
    }
    console.log("");
    return;
  }

  for (const name of opts.providers) {
    const provider = makeProvider(name);
    const evals =
      opts.store === "qdrant-backfill"
        ? await rankThroughPostgresThenQdrant(provider, documents, queries, vectorStore)
        : vectorStore
          ? await rankWithVectorStore(
              vectorStore,
              provider,
              documents,
              queries,
              opts.store === "qdrant-bm25"
                ? "bm25"
                : opts.store === "qdrant-hybrid"
                  ? "hybrid"
                  : "dense",
            )
          : await rankWithProvider(provider, documents, queries);
    const report = evaluateRetrieval(evals, opts.ks);
    const label =
      opts.store === "qdrant-bm25"
        ? "qdrant:bm25"
        : opts.store === "qdrant-hybrid"
          ? `qdrant:rrf(${provider.modelId}+bm25)`
          : provider.modelId;
    printReportRow(label, report, opts.ks);
    if (opts.verbose) {
      for (const e of evals) {
        const top = e.ranked.slice(0, 3).join(", ");
        console.log(`    "${e.query}" → ${top}`);
      }
    }
    if (reranker) {
      const rr = await applyRerank(reranker, provider, documents, queries, opts.rerankDepth);
      const rrReport = evaluateRetrieval(rr, opts.ks);
      printReportRow(`${provider.modelId}  +rerank`, rrReport, opts.ks);
    }
  }
  if (vectorStore) {
    await vectorStore.delete({ collectionIds: [EVAL_COLLECTION], source: "node" });
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
