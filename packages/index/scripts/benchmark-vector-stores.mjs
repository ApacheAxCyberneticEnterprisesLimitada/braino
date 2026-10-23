#!/usr/bin/env node

import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist", "vector-store-benchmark.js");

let benchmark;
try {
  benchmark = await import(DIST);
} catch {
  console.error(
    `Could not import ${DIST}\nBuild the package first: pnpm --filter @doco/index build`,
  );
  process.exit(1);
}

const { buildBenchmarkCorpus, exactRank, summarizeVectorStoreRun } = benchmark;
const { Client } = pg;

function parseArgs(argv) {
  const options = {
    size: 10_000,
    dimensions: 512,
    queryCount: 10,
    k: 10,
    warmup: 2,
    repetitions: 10,
    batchSize: 200,
    seed: 42,
    json: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const nextNumber = () => Number(argv[++index]);
    if (argument === "--") continue;
    if (argument === "--size") options.size = nextNumber();
    else if (argument === "--dimensions") options.dimensions = nextNumber();
    else if (argument === "--queries") options.queryCount = nextNumber();
    else if (argument === "--k") options.k = nextNumber();
    else if (argument === "--warmup") options.warmup = nextNumber();
    else if (argument === "--repetitions") options.repetitions = nextNumber();
    else if (argument === "--batch-size") options.batchSize = nextNumber();
    else if (argument === "--seed") options.seed = nextNumber();
    else if (argument === "--json") options.json = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  for (const [name, value] of Object.entries(options)) {
    if (name !== "json" && (!Number.isInteger(value) || value < 0)) {
      throw new Error(`${name} must be a non-negative integer`);
    }
  }
  if (options.size < 1 || options.dimensions < 2 || options.queryCount < 1 || options.k < 1) {
    throw new Error("size, queries, and k must be positive; dimensions must be at least 2");
  }
  return options;
}

function vectorLiteral(vector) {
  return `[${vector.join(",")}]`;
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

class PgvectorStore {
  name = "pgvector";

  constructor(url, dimensions, batchSize) {
    this.client = new Client({ connectionString: url });
    this.dimensions = dimensions;
    this.batchSize = batchSize;
  }

  async connect() {
    await this.client.connect();
  }

  async reset(points) {
    await this.client.query("DROP TABLE IF EXISTS vector_store_benchmark");
    await this.client.query("CREATE EXTENSION IF NOT EXISTS vector");
    await this.client.query(`
      CREATE TABLE vector_store_benchmark (
        id text PRIMARY KEY,
        collection_id text NOT NULL,
        embedding vector(${this.dimensions}) NOT NULL
      )
    `);

    for (const batch of chunks(points, this.batchSize)) {
      const parameters = [];
      const rows = batch.map((point, index) => {
        const offset = index * 3;
        parameters.push(point.id, point.collectionId, vectorLiteral(point.vector));
        return `($${offset + 1}, $${offset + 2}, $${offset + 3}::vector)`;
      });
      await this.client.query(
        `INSERT INTO vector_store_benchmark (id, collection_id, embedding) VALUES ${rows.join(",")}`,
        parameters,
      );
    }

    await this.client.query(
      "CREATE INDEX vector_store_benchmark_collection_idx ON vector_store_benchmark (collection_id)",
    );
    await this.client.query(`
      CREATE INDEX vector_store_benchmark_hnsw_idx
      ON vector_store_benchmark USING hnsw (embedding vector_cosine_ops)
      WITH (m = 32, ef_construction = 200)
    `);
    await this.client.query("ANALYZE vector_store_benchmark");
    await this.client.query("SET hnsw.ef_search = 100");
  }

  async search(query, collectionId, k) {
    const result = await this.client.query(
      `SELECT id
       FROM vector_store_benchmark
       WHERE collection_id = $2
       ORDER BY embedding <=> $1::vector
       LIMIT $3`,
      [vectorLiteral(query), collectionId, k],
    );
    return result.rows.map((row) => row.id);
  }

  async close() {
    await this.client.end();
  }
}

class QdrantStore {
  name = "qdrant";
  collection = "doco_vector_store_benchmark";

  constructor(url, dimensions, batchSize) {
    this.url = url.replace(/\/$/, "");
    this.dimensions = dimensions;
    this.batchSize = batchSize;
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.url}${path}`, {
      ...options,
      headers: { "content-type": "application/json", ...options.headers },
    });
    if (!response.ok) {
      throw new Error(
        `Qdrant ${options.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`,
      );
    }
    return response.json();
  }

  async connect() {
    const response = await fetch(`${this.url}/readyz`);
    if (!response.ok) throw new Error(`Qdrant is not ready: ${response.status}`);
  }

  async reset(points) {
    const existing = await fetch(`${this.url}/collections/${this.collection}`);
    if (existing.ok) {
      await this.request(`/collections/${this.collection}`, { method: "DELETE" });
    }
    await this.request(`/collections/${this.collection}`, {
      method: "PUT",
      body: JSON.stringify({
        vectors: { size: this.dimensions, distance: "Cosine" },
        hnsw_config: { m: 32, ef_construct: 200 },
        // Disable HNSW construction during bulk upload. Building once after
        // loading mirrors pgvector's CREATE INDEX-after-INSERT path.
        optimizers_config: { indexing_threshold: 0 },
      }),
    });
    await this.request(`/collections/${this.collection}/index?wait=true`, {
      method: "PUT",
      body: JSON.stringify({ field_name: "collection_id", field_schema: "keyword" }),
    });

    let numericId = 0;
    for (const batch of chunks(points, this.batchSize)) {
      await this.request(`/collections/${this.collection}/points?wait=true`, {
        method: "PUT",
        body: JSON.stringify({
          points: batch.map((point) => ({
            id: ++numericId,
            vector: point.vector,
            payload: { id: point.id, collection_id: point.collectionId },
          })),
        }),
      });
    }
    await this.request(`/collections/${this.collection}`, {
      method: "PATCH",
      body: JSON.stringify({ optimizers_config: { indexing_threshold: 100 } }),
    });
    await this.waitForIndex();
  }

  async waitForIndex() {
    for (let attempt = 0; attempt < 1_200; attempt++) {
      const response = await this.request(`/collections/${this.collection}`);
      if (response.result?.status === "green" && response.result?.indexed_vectors_count > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Qdrant did not finish indexing within five minutes");
  }

  async search(query, collectionId, k) {
    const response = await this.request(`/collections/${this.collection}/points/query`, {
      method: "POST",
      body: JSON.stringify({
        query,
        filter: { must: [{ key: "collection_id", match: { value: collectionId } }] },
        params: { hnsw_ef: 100, exact: false },
        limit: k,
        with_payload: ["id"],
      }),
    });
    return response.result.points.map((point) => point.payload.id);
  }

  async close() {}
}

async function benchmarkStore(store, corpus, options) {
  await store.connect();
  const ingestStarted = performance.now();
  await store.reset(corpus.points);
  const ingestMs = performance.now() - ingestStarted;

  for (let pass = 0; pass < options.warmup; pass++) {
    for (const query of corpus.queries) {
      await store.search(query.vector, query.collectionId, options.k);
    }
  }

  const durationsMs = [];
  const rankedByQuery = new Map();
  for (let pass = 0; pass < options.repetitions; pass++) {
    for (const query of corpus.queries) {
      const started = performance.now();
      const ranked = await store.search(query.vector, query.collectionId, options.k);
      durationsMs.push(performance.now() - started);
      if (pass === 0) rankedByQuery.set(query.query, ranked);
    }
  }

  const queryResults = corpus.queries.map((query) => ({
    query: query.query,
    ranked: rankedByQuery.get(query.query) ?? [],
    exact: exactRank(query.vector, corpus.points, query.collectionId, options.k),
    relevantIds: query.relevantIds,
  }));
  await store.close();

  return summarizeVectorStoreRun({
    engine: store.name,
    queryResults,
    durationsMs,
    ingestMs,
    pointCount: corpus.points.length,
    k: options.k,
  });
}

function format(number) {
  return Number(number).toFixed(2);
}

function printReports(reports, options) {
  console.log(
    `\nIdentical corpus: ${options.size.toLocaleString()} points × ${options.dimensions} dimensions; ` +
      `${options.queryCount} queries; k=${options.k}; ${options.repetitions} measured repetitions`,
  );
  console.log("\nengine     ANN recall@k  MRR    p50 ms  p75 ms  p95 ms  ingest ms");
  console.log("-----------------------------------------------------------------");
  for (const report of reports) {
    console.log(
      `${report.engine.padEnd(11)}${format(report.annRecallAtK * 100).padStart(10)}%  ` +
        `${format(report.quality.mrr).padStart(5)}  ${format(report.latencyMs.p50).padStart(6)}  ` +
        `${format(report.latencyMs.p75).padStart(6)}  ${format(report.latencyMs.p95).padStart(6)}  ` +
        `${format(report.ingestMs).padStart(9)}`,
    );
  }
  console.log("");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const corpus = buildBenchmarkCorpus(options);
  const pgvector = new PgvectorStore(
    process.env.PG_BENCHMARK_URL ?? "postgresql://postgres:benchmark@127.0.0.1:55432/postgres",
    options.dimensions,
    options.batchSize,
  );
  const qdrant = new QdrantStore(
    process.env.QDRANT_BENCHMARK_URL ?? "http://127.0.0.1:56333",
    options.dimensions,
    options.batchSize,
  );
  const reports = [];
  for (const store of [pgvector, qdrant])
    reports.push(await benchmarkStore(store, corpus, options));
  if (options.json) console.log(JSON.stringify({ options, reports }, null, 2));
  else printReports(reports, options);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
