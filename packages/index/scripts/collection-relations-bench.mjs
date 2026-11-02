#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

import {
  buildCollectionRelationsPrompt,
  collectionRelationshipsResponseSchema,
  parseCollectionRelationsArgs,
  scoreCollectionRelationships,
  validateCollectionRelationsFixture,
  visibleBenchmarkFixture,
} from "./collection-relations-bench-lib.mjs";

function decodedContent(envelope) {
  if (!envelope || typeof envelope !== "object" || !envelope.message) {
    throw new Error("Ollama returned an invalid collection relationship envelope");
  }
  const content = envelope.message.content;
  try {
    return typeof content === "string" ? JSON.parse(content) : content;
  } catch {
    throw new Error("Ollama returned invalid JSON for collection relationships");
  }
}

async function inferRelationships(options, collections) {
  const prompt = buildCollectionRelationsPrompt(collections, { anchor: options.anchor });
  const startedAt = performance.now();
  const response = await fetch(options.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.apiToken ? { authorization: `Bearer ${options.apiToken}` } : {}),
    },
    signal: AbortSignal.timeout(options.timeoutMs),
    body: JSON.stringify({
      model: options.model,
      stream: false,
      think: false,
      format: collectionRelationshipsResponseSchema,
      keep_alive: "10m",
      options: {
        temperature: 0,
        seed: 42,
        num_ctx: options.numCtx,
        num_predict: 4096,
      },
      messages: [
        {
          role: "system",
          content:
            "You infer a sparse, evidence-linked graph among knowledge collections. Precision is more important than recall. Never infer a relationship from naming similarity alone.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });
  const latencyMs = performance.now() - startedAt;
  if (!response.ok) {
    throw new Error(`Ollama collection relationship inference failed with HTTP ${response.status}`);
  }
  const envelope = await response.json();
  const decoded = decodedContent(envelope);
  if (!decoded || !Array.isArray(decoded.relationships)) {
    throw new Error("Ollama returned an invalid collection relationship result");
  }
  return {
    relationships: decoded.relationships,
    latencyMs,
    promptTokens: Number(envelope.prompt_eval_count ?? 0),
    outputTokens: Number(envelope.eval_count ?? 0),
    ollamaDurationMs: Number(envelope.total_duration ?? 0) / 1_000_000,
  };
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function aggregateBatch(runs) {
  const metric = (key) => mean(runs.map((run) => run.metrics[key]));
  return {
    batchSize: runs[0]?.batchSize ?? 0,
    repeats: runs.length,
    gold: metric("gold"),
    predicted: metric("predicted"),
    precision: metric("precision"),
    recall: metric("recall"),
    f1: metric("f1"),
    endpointPairRecall: metric("endpointPairRecall"),
    typeAccuracy: metric("typeAccuracy"),
    directionAccuracy: metric("directionAccuracy"),
    unsupportedRate: metric("unsupportedRate"),
    invalidEdges: metric("invalidEdges"),
    latencyMs: mean(runs.map((run) => run.latencyMs)),
    promptTokens: mean(runs.map((run) => run.promptTokens)),
    outputTokens: mean(runs.map((run) => run.outputTokens)),
  };
}

function percent(value) {
  return `${(100 * value).toFixed(1)}%`;
}

function printSummary(summary) {
  const rows = summary.map((row) => ({
    collections: row.batchSize,
    gold: row.gold.toFixed(0),
    predicted: row.predicted.toFixed(1),
    precision: percent(row.precision),
    recall: percent(row.recall),
    F1: percent(row.f1),
    pairRecall: percent(row.endpointPairRecall),
    type: percent(row.typeAccuracy),
    direction: percent(row.directionAccuracy),
    unsupported: percent(row.unsupportedRate),
    latency: `${(row.latencyMs / 1000).toFixed(1)}s`,
    promptTokens: row.promptTokens.toFixed(0),
    outputTokens: row.outputTokens.toFixed(0),
  }));
  console.table(rows);
}

async function main() {
  const options = parseCollectionRelationsArgs(process.argv.slice(2));
  const fixture = validateCollectionRelationsFixture(
    JSON.parse(await readFile(options.fixture, "utf8")),
  );
  const largestBatch = options.batchSizes.at(-1) ?? 0;
  if (largestBatch > fixture.collections.length) {
    throw new Error(
      `Largest batch ${largestBatch} exceeds fixture size ${fixture.collections.length}`,
    );
  }

  const anchorIndex = options.anchor
    ? fixture.collections.findIndex((collection) => collection.id === options.anchor)
    : 0;
  const warmupFixture = visibleBenchmarkFixture(
    fixture,
    Math.max(1, anchorIndex + 1),
    options.anchor,
  );

  // Load the model before measuring batch latency. The warmup output is discarded.
  await inferRelationships(options, warmupFixture.collections);

  const runs = [];
  let failure = null;
  try {
    for (const batchSize of options.batchSizes) {
      const visible = visibleBenchmarkFixture(fixture, batchSize, options.anchor);
      for (let repeat = 1; repeat <= options.repeats; repeat++) {
        const inferred = await inferRelationships(options, visible.collections);
        const metrics = scoreCollectionRelationships(visible, inferred.relationships);
        runs.push({
          batchSize,
          repeat,
          latencyMs: inferred.latencyMs,
          promptTokens: inferred.promptTokens,
          outputTokens: inferred.outputTokens,
          ollamaDurationMs: inferred.ollamaDurationMs,
          metrics,
          predictions: inferred.relationships,
        });
        console.log(
          `${batchSize} collections, run ${repeat}/${options.repeats}: precision=${percent(metrics.precision)} recall=${percent(metrics.recall)} latency=${(inferred.latencyMs / 1000).toFixed(1)}s`,
        );
      }
    }
  } catch (error) {
    failure = error;
  }

  const completedBatchSizes = options.batchSizes.filter((batchSize) =>
    runs.some((run) => run.batchSize === batchSize),
  );
  const summary = completedBatchSizes.map((batchSize) =>
    aggregateBatch(runs.filter((run) => run.batchSize === batchSize)),
  );
  const report = {
    benchmark: fixture.name ?? "collection relationships",
    fixtureVersion: fixture.version ?? null,
    generatedAt: new Date().toISOString(),
    model: options.model,
    anchor: options.anchor || null,
    url: options.url,
    numCtx: options.numCtx,
    batchSizes: options.batchSizes,
    repeats: options.repeats,
    collectionCount: fixture.collections.length,
    goldRelationshipCount: fixture.relationships.length,
    status: failure ? "failed" : "complete",
    failure: failure instanceof Error ? failure.message : failure,
    summary,
    runs,
  };
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log("");
  printSummary(summary);
  console.log(`\nReport: ${options.output}`);
  if (failure) throw failure;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
