#!/usr/bin/env node

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist", "qdrant-vector-store.js");
const { QdrantVectorStore } = await import(DIST).catch(() => {
  throw new Error("Build @doco/index first: pnpm --filter @doco/index build");
});

const url = (process.env.QDRANT_URL ?? "http://127.0.0.1:6333").replace(/\/$/, "");
const apiKey = process.env.QDRANT_API_KEY;
const collection = "doco_local_smoke";
const headers = { ...(apiKey ? { "api-key": apiKey } : {}) };

async function removeSmokeCollection() {
  const response = await fetch(`${url}/collections/${collection}`, { method: "DELETE", headers });
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Could not clean up smoke collection (${response.status}): ${await response.text()}`,
    );
  }
}

await removeSmokeCollection();
const store = new QdrantVectorStore({ url, apiKey, collection, dimensions: 4 });

try {
  await store.upsert([
    {
      collection_id: "workspace-alpha",
      source: "node",
      entity_id: "decision-java",
      chunk_index: 0,
      model_id: "local:test",
      content_hash: "java-21",
      chunk_text: "Solar uses Java 21.",
      embedding: [1, 0, 0, 0],
    },
    {
      collection_id: "workspace-alpha",
      source: "node",
      entity_id: "decision-python",
      chunk_index: 0,
      model_id: "local:test",
      content_hash: "python-3",
      chunk_text: "Radar uses Python 3.",
      embedding: [0, 1, 0, 0],
    },
    {
      collection_id: "workspace-other",
      source: "node",
      entity_id: "decision-private",
      chunk_index: 0,
      model_id: "local:test",
      content_hash: "private",
      chunk_text: "A private workspace also mentions Java.",
      embedding: [1, 0, 0, 0],
    },
  ]);

  const hits = await store.rank({
    collectionIds: ["workspace-alpha"],
    source: "node",
    modelId: "local:test",
    queryEmbedding: [1, 0, 0, 0],
    limit: 2,
  });
  if (hits[0]?.entity_id !== "decision-java") {
    throw new Error(`Unexpected ranking: ${JSON.stringify(hits)}`);
  }
  if (hits.some((hit) => hit.entity_id === "decision-private")) {
    throw new Error("Collection filtering leaked a result from another workspace.");
  }

  await store.delete({ collectionIds: ["workspace-alpha"], source: "node" });
  const afterDelete = await store.rank({
    collectionIds: ["workspace-alpha"],
    source: "node",
    modelId: "local:test",
    queryEmbedding: [1, 0, 0, 0],
    limit: 2,
  });
  if (afterDelete.length !== 0)
    throw new Error("Filtered delete did not remove the workspace rows.");

  console.log("Qdrant vector-store smoke test passed: upsert, rank, tenant filter, and delete.");
} finally {
  await removeSmokeCollection();
}
