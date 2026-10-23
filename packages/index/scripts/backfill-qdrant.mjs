#!/usr/bin/env node

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist");
const { backfillEmbeddingsToVectorStore } = await import(join(DIST, "qdrant-backfill.js")).catch(
  () => {
    throw new Error("Build @doco/index first: pnpm --filter @doco/index build");
  },
);
const { QdrantVectorStore } = await import(join(DIST, "qdrant-vector-store.js"));
const { closePool, ensureSchema, withClient } = await import("@doco/db");

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function localOnly(name, value) {
  const host = new URL(value).hostname;
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
    throw new Error(`${name} must point to localhost for this local migration command.`);
  }
}

const databaseUrl =
  process.env.DOCO_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://doco:doco-local@127.0.0.1:55432/doco";
const qdrantUrl = process.env.QDRANT_URL ?? "http://127.0.0.1:6333";
localOnly("DATABASE_URL", databaseUrl);
localOnly("QDRANT_URL", qdrantUrl);
process.env.DOCO_DATABASE_URL = databaseUrl;

const collectionIds = process.argv.flatMap((arg, index, args) =>
  arg === "--collection" && args[index + 1] ? [args[index + 1]] : [],
);
const batchSize = Number(option("--batch-size") ?? 500);
const store = new QdrantVectorStore({
  url: qdrantUrl,
  apiKey: process.env.QDRANT_API_KEY,
  collection: process.env.DOCO_QDRANT_COLLECTION,
});

try {
  await ensureSchema();
  const report = await withClient(async (client) => {
    const selectedCollections =
      collectionIds.length > 0
        ? collectionIds
        : (
            await client.query(
              "SELECT DISTINCT collection_id FROM embeddings ORDER BY collection_id",
            )
          ).rows.map((row) => row.collection_id);
    if (selectedCollections.length > 0) {
      await store.delete({ collectionIds: selectedCollections });
    }
    return backfillEmbeddingsToVectorStore(client, store, {
      batchSize,
      collectionIds: collectionIds.length > 0 ? collectionIds : undefined,
      onBatch: ({ rows, batches }) => console.log(`Backfilled ${rows} rows in ${batches} batches`),
    });
  });
  console.log(`Qdrant backfill complete: ${report.rows} rows in ${report.batches} batches.`);
} finally {
  await closePool();
}
