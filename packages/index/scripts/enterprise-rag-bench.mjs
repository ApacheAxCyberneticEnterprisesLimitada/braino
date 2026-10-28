#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { text } from "node:stream/consumers";
import { finished } from "node:stream/promises";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import yauzl from "yauzl";

import {
  dedupeRankedDocuments,
  parseBenchmarkArgs,
  parseBenchmarkDocument,
  retrievalSummary,
  runnableQuestions,
} from "./enterprise-rag-bench-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_DIST = resolve(HERE, "..", "dist", "index.js");
const DB_DIST = resolve(HERE, "..", "..", "db", "dist", "index.js");
const BENCHMARK_WORKSPACE = "workspace_enterpriserag_bench";
const BENCHMARK_COLLECTION = "collection_enterpriserag_bench";
const ACCESS_SCOPES = ["workspace"];
const DEFAULT_ANSWER_MODEL = "claude-sonnet-4-6";

const opts = parseBenchmarkArgs(process.argv.slice(2));
process.env.DOCO_DATABASE_URL = opts.databaseUrl;

const index = await import(INDEX_DIST);
const db = await import(DB_DIST);
const provider = index.getDefaultEmbeddingProvider();
if (provider.modelId === "noop") {
  throw new Error("EnterpriseRAG-Bench requires a configured embedding provider");
}

let client;
try {
  await db.ensureSchema();
  client = await db.getPool().connect();
  await ensureBenchmarkCollection(client);
  const extractor = opts.graph
    ? index.configuredRetrievalExtractor()
    : index.EMPTY_RETRIEVAL_EXTRACTOR;
  const indexing = await indexArchives(client, provider, opts.archives, extractor);
  const { documentIds, ...indexingSummary } = indexing;
  const questions = readJsonLines(opts.questions);
  const selected = opts.eligibleOnly ? runnableQuestions(questions, documentIds) : questions;
  if (selected.length === 0) throw new Error("No benchmark questions are runnable");
  if (!opts.eligibleOnly && documentIds.size < 500_000) {
    throw new Error(
      `Full runs require the complete corpus; indexed only ${documentIds.size} documents`,
    );
  }
  const report = await runQuestions(client, provider, selected, opts);
  writeFileSync(
    `${opts.output}.summary.json`,
    `${JSON.stringify({ dataset: "EnterpriseRAG-Bench v1.0.0", indexing: indexingSummary, ...report }, null, 2)}\n`,
  );
  console.log(JSON.stringify({ indexing: indexingSummary, ...report }, null, 2));
} finally {
  client?.release();
  await db.closePool();
}

async function ensureBenchmarkCollection(c) {
  await c.query(
    `INSERT INTO workspaces (id, handle, name)
     VALUES ($1, 'enterpriserag-bench', 'EnterpriseRAG-Bench')
     ON CONFLICT (id) DO NOTHING`,
    [BENCHMARK_WORKSPACE],
  );
  await c.query(
    `INSERT INTO collections
       (id, handle, owner_id, workspace_id, visibility, goal, data)
     VALUES ($1, 'enterpriserag-bench', $2, $2, 'private',
             'Reproducible EnterpriseRAG-Bench corpus.', '{"template_handle":"generic"}')
     ON CONFLICT (id) DO NOTHING`,
    [BENCHMARK_COLLECTION, BENCHMARK_WORKSPACE],
  );
}

async function indexArchives(c, embeddingProvider, archives, extractor) {
  const ready = await loadReadyDocuments(c, embeddingProvider.modelId);
  const documentIds = new Set();
  let documents = 0;
  let skipped = 0;
  let chunks = 0;
  let embedded = 0;
  let characters = 0;
  let pending = [];
  const startedAt = performance.now();

  const flush = async () => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    const targets = { chunkIds: [], entityIds: [], relationIds: [] };
    await c.query("BEGIN");
    try {
      for (const document of batch) {
        const result = await index.ingestRetrievalSource(
          c,
          {
            collectionId: BENCHMARK_COLLECTION,
            ...document,
            accessScopes: ACCESS_SCOPES,
          },
          { extractor },
        );
        await c.query("UPDATE retrieval_documents SET extraction_id = $1 WHERE id = $2", [
          extractor.id,
          result.documentId,
        ]);
        targets.chunkIds.push(...result.chunkIds);
        targets.entityIds.push(...result.entityIds);
        targets.relationIds.push(...result.relationIds);
      }
      await c.query("COMMIT");
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    }
    const result = await embedTargets(targets, embeddingProvider);
    chunks += targets.chunkIds.length;
    embedded += result.computed;
    documents += batch.length;
    if ((documents + skipped) % 1_000 < batch.length) {
      console.error(
        `indexed=${documents} skipped=${skipped} chunks=${chunks} embedded=${embedded}`,
      );
    }
  };

  for (const archive of archives) {
    const sourceHint = sourceFromArchive(archive);
    await forEachZipText(archive, async (entryName, body) => {
      const document = parseBenchmarkDocument(entryName, body, sourceHint);
      documentIds.add(document.externalId);
      characters += document.content.length;
      const key = `${document.source}\n${document.externalId}`;
      const state = ready.get(key);
      if (
        state?.contentHash === md5(document.content) &&
        state.extractionId === extractor.id &&
        state.embedded
      ) {
        skipped++;
        return;
      }
      pending.push(document);
      if (pending.length >= 100) await flush();
    });
  }
  await flush();
  return {
    documents: documentIds.size,
    indexed: documents,
    skipped,
    chunks,
    embedded,
    characters,
    embeddingModel: embeddingProvider.modelId,
    graph: {
      enabled: extractor !== index.EMPTY_RETRIEVAL_EXTRACTOR,
      extractor: extractor.id,
      ...(await graphCounts(c)),
    },
    durationMs: Math.round(performance.now() - startedAt),
    documentIds,
  };
}

async function embedTargets(targets, embeddingProvider) {
  const groups = Array.from({ length: 4 }, () => ({
    chunkIds: [],
    entityIds: [],
    relationIds: [],
  }));
  for (const key of ["chunkIds", "entityIds", "relationIds"]) {
    targets[key].forEach((id, index) => groups[index % groups.length][key].push(id));
  }
  const reports = await Promise.all(
    groups
      .filter(
        (group) => group.chunkIds.length + group.entityIds.length + group.relationIds.length > 0,
      )
      .map((group) =>
        db.withClient((embeddingClient) =>
          db.upsertRetrievalEmbeddings(embeddingClient, group, embeddingProvider),
        ),
      ),
  );
  return {
    computed: reports.reduce((sum, report) => sum + report.computed, 0),
  };
}

async function loadReadyDocuments(c, modelId) {
  const rows = (
    await c.query(
      `SELECT d.source, d.external_id, d.content_hash, d.extraction_id,
              count(ch.id) > 0 AND count(e.entity_id) = count(ch.id) AS embedded
         FROM retrieval_documents d
         LEFT JOIN retrieval_chunks ch ON ch.document_id = d.id
         LEFT JOIN embeddings e
           ON e.collection_id = ch.collection_id
          AND e.source = 'retrieval_chunk'
          AND e.entity_id = ch.id
          AND e.model_id = $2
        WHERE d.collection_id = $1
        GROUP BY d.id, d.source, d.external_id, d.content_hash`,
      [BENCHMARK_COLLECTION, modelId],
    )
  ).rows;
  return new Map(
    rows.map((row) => [
      `${row.source}\n${row.external_id}`,
      {
        contentHash: row.content_hash,
        extractionId: row.extraction_id,
        embedded: row.embedded,
      },
    ]),
  );
}

async function graphCounts(c) {
  const counts = {};
  for (const [name, table] of [
    ["entities", "retrieval_entities"],
    ["mentions", "retrieval_mentions"],
    ["relations", "retrieval_relations"],
  ]) {
    const result = await c.query(
      `SELECT count(*) AS count FROM ${table} WHERE collection_id = $1`,
      [BENCHMARK_COLLECTION],
    );
    counts[name] = Number(result.rows[0].count);
  }
  return counts;
}

async function runQuestions(c, embeddingProvider, questions, args) {
  const priorAnswers = existsSync(args.output)
    ? new Map(readJsonLines(args.output).map((item) => [item.question_id, item]))
    : new Map();
  const answerStream = createWriteStream(args.output, { flags: "a" });
  const cases = [];
  const latencies = [];
  try {
    for (let at = 0; at < questions.length; at++) {
      const question = questions[at];
      const startedAt = performance.now();
      const [queryEmbedding] = await embeddingProvider.embed([question.question], "query");
      const retrieval = await index.multiPathRetrieve(c, {
        collectionId: BENCHMARK_COLLECTION,
        queryText: question.question,
        semantic: { queryEmbedding, modelId: embeddingProvider.modelId },
        accessScopes: ACCESS_SCOPES,
        limit: Math.max(100, args.topK * 10),
        chunkCandidateLimit: 200,
      });
      const ranked = dedupeRankedDocuments(retrieval.items).slice(0, args.topK);
      const documentIds = ranked.map((item) => item.externalId);
      cases.push({ expected: question.expected_doc_ids, retrieved: documentIds });
      latencies.push(performance.now() - startedAt);

      if (!priorAnswers.has(question.question_id)) {
        const row = {
          question_id: question.question_id,
          ...(args.answers ? { answer: await answerQuestion(c, question.question, ranked) } : {}),
          document_ids: documentIds,
        };
        answerStream.write(`${JSON.stringify(row)}\n`);
      }
      console.error(
        `[${at + 1}/${questions.length}] ${question.question_id} ` +
          `recall=${caseRecall(question.expected_doc_ids, documentIds).toFixed(3)} ` +
          `retrieval_ms=${Math.round(latencies.at(-1))}`,
      );
    }
  } finally {
    answerStream.end();
    await finished(answerStream);
  }
  const ordered = [...latencies].sort((a, b) => a - b);
  return {
    questions: questions.length,
    topK: args.topK,
    answersGenerated: args.answers,
    retrieval: retrievalSummary(cases),
    latencyMs: {
      p50: Math.round(percentile(ordered, 0.5)),
      p95: Math.round(percentile(ordered, 0.95)),
    },
    output: args.output,
  };
}

async function answerQuestion(c, question, ranked) {
  const rows = (
    await c.query(
      `SELECT d.id, d.source, d.external_id, d.locator, d.title,
              string_agg(ch.text, E'\n\n' ORDER BY ch.chunk_index) AS content
         FROM retrieval_documents d
         JOIN retrieval_chunks ch ON ch.document_id = d.id
        WHERE d.id = ANY($1::text[])
        GROUP BY d.id, d.source, d.external_id, d.locator, d.title`,
      [ranked.map((item) => item.documentId)],
    )
  ).rows;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const documents = ranked
    .map((item) => byId.get(item.documentId))
    .filter(Boolean)
    .map(
      (document) =>
        `[DOCUMENT ${document.external_id}]\n` +
        `Source: ${document.source}\nTitle: ${document.title ?? "(untitled)"}\n` +
        `Locator: ${document.locator ?? "(none)"}\n${document.content}`,
    )
    .join("\n\n---\n\n")
    .slice(0, 700_000);
  const response = await anthropicMessage({
    system:
      "Answer the question only from the supplied enterprise documents. Be complete and reconcile conflicts. If the documents do not contain the answer, say that the information was not found. Return only the answer, without a preamble or source list.",
    user: `Question: ${question}\n\n${documents}`,
  });
  return response;
}

async function anthropicMessage({ system, user }) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        ...(process.env.ANTHROPIC_WORKSPACE_ID
          ? { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID }
          : {}),
      },
      body: JSON.stringify({
        model:
          process.env.SENOR_DOCO_ANTHROPIC_MODEL ||
          process.env.DOCO_ASSISTANT_MODEL ||
          DEFAULT_ANSWER_MODEL,
        max_tokens: 4_096,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (response.ok) {
      const payload = await response.json();
      return payload.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
    }
    const body = await response.text();
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      const retrySeconds = Number(response.headers.get("retry-after")) || 5 * 2 ** attempt;
      await wait(retrySeconds * 1_000);
      continue;
    }
    throw new Error(`Anthropic answer request failed (${response.status}): ${body}`);
  }
  throw new Error("Anthropic answer request exhausted retries");
}

function sourceFromArchive(path) {
  const match = /^(.+?)_slice_\d+\.zip$/i.exec(basename(path));
  return match?.[1];
}

async function forEachZipText(path, visit) {
  const archive = await promisify(yauzl.open)(path, { lazyEntries: true });
  await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const reject = (error) => {
      if (settled) return;
      settled = true;
      archive.close();
      rejectPromise(error);
    };
    archive.on("error", reject);
    archive.on("end", () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    });
    archive.on("entry", (entry) => {
      if (/\/$/.test(entry.fileName) || !entry.fileName.toLowerCase().endsWith(".txt")) {
        archive.readEntry();
        return;
      }
      archive.openReadStream(entry, (error, stream) => {
        if (error) return reject(error);
        text(stream)
          .then((body) => visit(entry.fileName, body))
          .then(() => archive.readEntry(), reject);
      });
    });
    archive.readEntry();
  });
}

function readJsonLines(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function md5(value) {
  return createHash("md5").update(value).digest("hex");
}

function caseRecall(expected, retrieved) {
  if (expected.length === 0) return 0;
  const found = expected.filter((id) => retrieved.includes(id)).length;
  return found / expected.length;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}
