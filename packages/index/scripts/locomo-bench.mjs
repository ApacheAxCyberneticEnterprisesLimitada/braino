#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  categoryCounts,
  formatSessionDocument,
  parseBenchmarkArgs,
  parseJudgeLabel,
  selectStratifiedQuestions,
} from "./locomo-bench-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_DIST = resolve(HERE, "..", "dist", "index.js");
const DB_DIST = resolve(HERE, "..", "..", "db", "dist", "index.js");
const BENCHMARK_WORKSPACE = "workspace_locomo_benchmark";
const ACCESS_SCOPES = ["workspace"];
const CATEGORY_NAMES = {
  1: "multi-hop",
  2: "temporal",
  3: "open-domain",
  4: "single-hop",
};
const OMNIMEMEVAL_COMMIT = "7c79d46e31dd85f3da2509b430bba9406656dd28";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Copied verbatim from OmniMemEval at OMNIMEMEVAL_COMMIT so the pilot's answer
// and judge stages stay comparable even though Braino owns the retrieval stage.
const ANSWER_PROMPT = `
    You are a knowledgeable and helpful AI assistant.

   # CONTEXT:
   You have access to memories from two speakers in a conversation. These memories contain
   timestamped information that may be relevant to answering the question.

   # INSTRUCTIONS:
   1. Carefully analyze all provided memories. Synthesize information across different entries if needed to form a complete answer.
   2. Pay close attention to the timestamps to determine the answer. If memories contain contradictory information, the **most recent memory** is the source of truth.
   3. If the question asks about a specific event or fact, look for direct evidence in the memories.
   4. Your answer must be grounded in the memories. However, you may use general world knowledge to interpret or complete information found within a memory (e.g., identifying a landmark mentioned by description).
   5. If the question involves time references (like "last year", "two months ago", etc.), you **must** calculate the actual date based on the memory's timestamp. For example, if a memory from 4 May 2022 mentions "went to India last year," then the trip occurred in 2021.
   6. Always convert relative time references to specific dates, months, or years in your final answer.
   7. Do not confuse character names mentioned in memories with the actual users who created them.
   8. Keep the answer concise and direct, with no extra description. For list, commonality, or multi-item questions, include all distinct supported items even if this exceeds 5-6 words.

   # APPROACH (Think step by step):
   1. First, examine all memories that contain information related to the question.
   2. Synthesize findings from multiple memories if a single entry is insufficient.
   3. Examine timestamps and content carefully, looking for explicit dates, times, locations, or events.
   4. If the answer requires calculation (e.g., converting relative time references), perform the calculation.
   5. Formulate a precise, concise answer based on the evidence from the memories (and allowed world knowledge).
   6. Double-check that your answer directly addresses the question asked and adheres to all instructions.
   7. Ensure your final answer is specific and avoids vague time references.

   {context}

   Question: {question}

   Answer:
   `;

const JUDGE_SYSTEM_PROMPT =
  "You are an expert grader that determines if answers to questions match a gold standard answer.";

const JUDGE_PROMPT = `
    Your task is to label an answer to a question as 'CORRECT' or 'WRONG'. You will be given the following data:
        (1) a question (posed by one user to another user),
        (2) a 'gold' (ground truth) answer,
        (3) a generated answer
    which you will score as CORRECT/WRONG.

    The point of the question is to ask about something one user should know about the other user based on their prior conversations.
    The gold answer will usually be a concise and short answer that includes the referenced topic, for example:
    Question: Do you remember what I got the last time I went to Hawaii?
    Gold answer: A shell necklace
    The generated answer might be much longer, but you should be generous with your grading - as long as it touches on the same topic as the gold answer, it should be counted as CORRECT.

    For time related questions, the gold answer will be a specific date, month, year, etc. The generated answer might be much longer or use relative time references (like "last Tuesday" or "next month"), but you should be generous with your grading - as long as it refers to the same date or time period as the gold answer, it should be counted as CORRECT. Even if the format differs (e.g., "May 7th" vs "7 May"), consider it CORRECT if it's the same date.

    Now it's time for the real question:
    Question: {question}
    Gold answer: {golden_answer}
    Generated answer: {response}

    First, provide a short (one sentence) explanation of your reasoning, then finish with CORRECT or WRONG.
    Do NOT include both CORRECT and WRONG in your response, or it will break the evaluation script.

    Just return the label CORRECT or WRONG in a json format with the key as "label".
    `;

process.env.OPENROUTER_API_KEY ||= process.env.OPEN_ROUTER_API_KEY;
const opts = parseBenchmarkArgs(process.argv.slice(2));
process.env.DOCO_DATABASE_URL = opts.databaseUrl;

const index = await import(INDEX_DIST);
const db = await import(DB_DIST);
const provider = index.getDefaultEmbeddingProvider();
if (provider.modelId === "noop") throw new Error("LoCoMo requires a configured embedding provider");
const extractor = opts.graph
  ? index.configuredRetrievalExtractor()
  : index.EMPTY_RETRIEVAL_EXTRACTOR;
const reranker = opts.rerank ? index.getDefaultReranker() : undefined;
if (opts.rerank && !reranker) throw new Error("LoCoMo --rerank requires VOYAGE_API_KEY");

mkdirSync(opts.output, { recursive: true });
const dataset = JSON.parse(readFileSync(opts.dataset, "utf8"));
if (!Array.isArray(dataset) || dataset.length !== 10) {
  throw new Error("LoCoMo dataset must contain exactly 10 conversations");
}
const selected = selectStratifiedQuestions(dataset, {
  rate: opts.sampleRate,
  seed: opts.seed,
});
const manifest = selected.map((question) => ({
  id: questionId(question),
  conversationIndex: question.conversationIndex,
  qaIndex: question.qaIndex,
  category: question.category,
  categoryName: CATEGORY_NAMES[question.category],
  question: question.question,
  answer: question.answer,
  evidence: question.evidence ?? [],
}));
writeJson(join(opts.output, "sample-manifest.json"), {
  dataset: "LoCoMo locomo10",
  datasetSha256: sha256(readFileSync(opts.dataset)),
  seed: opts.seed,
  sampleRate: opts.sampleRate,
  questions: manifest.length,
  categoryCounts: categoryCounts(manifest),
  manifest,
});

const startedAt = new Date().toISOString();
try {
  await db.ensureSchema();
  await ensureBenchmarkCollections(db, dataset.length);
  const indexing = await indexDataset(db, index, provider, extractor, dataset);
  const searches = await retrieveQuestions(db, index, provider, reranker, selected);
  const results = await answerAndJudge(searches, selected);
  const summary = summarize({ indexing, searches, results, startedAt });
  writeJson(join(opts.output, "summary.json"), summary);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await db.closePool();
}

function collectionId(conversationIndex) {
  return `collection_locomo_benchmark_${String(conversationIndex).padStart(2, "0")}`;
}

function questionId(question) {
  return `conv-${question.conversationIndex}:qa-${question.qaIndex}`;
}

async function ensureBenchmarkCollections(database, count) {
  await database.withClient(async (client) => {
    await client.query(
      `INSERT INTO workspaces (id, handle, name)
       VALUES ($1, 'locomo-benchmark', 'LoCoMo Benchmark')
       ON CONFLICT (id) DO NOTHING`,
      [BENCHMARK_WORKSPACE],
    );
    for (let conversationIndex = 0; conversationIndex < count; conversationIndex++) {
      await client.query(
        `INSERT INTO collections
           (id, handle, owner_id, workspace_id, visibility, goal, data)
         VALUES ($1, $2, $3, $3, 'private',
                 'Isolated LoCoMo benchmark conversation.', '{"template_handle":"generic"}')
         ON CONFLICT (id) DO NOTHING`,
        [
          collectionId(conversationIndex),
          `locomo-benchmark-${String(conversationIndex).padStart(2, "0")}`,
          BENCHMARK_WORKSPACE,
        ],
      );
    }
  });
}

async function indexDataset(database, indexModule, embeddingProvider, retrievalExtractor, samples) {
  const documents = samples.flatMap((sample, conversationIndex) => {
    const result = [];
    for (let sessionIndex = 0; sessionIndex < 100; sessionIndex++) {
      const document = formatSessionDocument(sample.conversation, conversationIndex, sessionIndex);
      if (document) result.push({ conversationIndex, document });
    }
    return result;
  });
  const ready = await loadReadyDocuments(database, embeddingProvider.modelId);
  const pending = documents.filter(({ conversationIndex, document }) => {
    const state = ready.get(`${collectionId(conversationIndex)}\n${document.externalId}`);
    return !(
      state?.contentHash === md5(document.content) &&
      state.extractionId === retrievalExtractor.id &&
      state.embedded
    );
  });
  let completed = 0;
  const started = performance.now();
  await mapLimit(pending, 4, async ({ conversationIndex, document }) => {
    await database.withClient(async (client) => {
      const report = await indexModule.ingestRetrievalSource(
        client,
        {
          collectionId: collectionId(conversationIndex),
          ...document,
          accessScopes: ACCESS_SCOPES,
        },
        { extractor: retrievalExtractor, embeddingProvider },
      );
      await client.query("UPDATE retrieval_documents SET extraction_id = $1 WHERE id = $2", [
        retrievalExtractor.id,
        report.documentId,
      ]);
    });
    completed++;
    if (completed % 20 === 0 || completed === pending.length) {
      console.error(`[index] ${completed}/${pending.length} changed sessions`);
    }
  });
  const counts = await retrievalCounts(database);
  return {
    documents: documents.length,
    indexed: pending.length,
    skipped: documents.length - pending.length,
    ...counts,
    embeddingModel: embeddingProvider.modelId,
    extractor: retrievalExtractor.id,
    durationMs: Math.round(performance.now() - started),
  };
}

async function retrieveQuestions(
  database,
  indexModule,
  embeddingProvider,
  activeReranker,
  questions,
) {
  const path = join(opts.output, "search-results.json");
  const existing = readArray(path);
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (let position = 0; position < questions.length; position++) {
    const question = questions[position];
    const id = questionId(question);
    if (byId.has(id)) continue;
    const started = performance.now();
    const [queryEmbedding] = await embeddingProvider.embed([question.question], "query");
    const retrieval = await database.withClient((client) =>
      indexModule.multiPathRetrieve(client, {
        collectionId: collectionId(question.conversationIndex),
        queryText: question.question,
        semantic: { queryEmbedding, modelId: embeddingProvider.modelId },
        accessScopes: ACCESS_SCOPES,
        limit: activeReranker ? 50 : opts.topK,
        chunkCandidateLimit: 100,
      }),
    );
    let ranked = retrieval.items;
    if (activeReranker && ranked.length > 0) {
      ranked = (
        await indexModule.rerankItems(
          activeReranker,
          question.question,
          ranked,
          (item) => `${item.title ?? ""}\n${item.text}`,
          opts.topK,
        )
      ).map(({ item }) => item);
    } else {
      ranked = ranked.slice(0, opts.topK);
    }
    const context = ranked
      .map((item, rank) => `[Memory ${rank + 1}: ${item.title ?? item.externalId}]\n${item.text}`)
      .join("\n\n");
    const evidence = (question.evidence ?? []).map(String);
    const foundEvidence = evidence.filter((evidenceId) => context.includes(evidenceId));
    const record = {
      id,
      question: question.question,
      context,
      contextCharacters: context.length,
      retrieved: ranked.map((item) => ({
        externalId: item.externalId,
        title: item.title,
        paths: item.paths,
      })),
      evidence,
      foundEvidence,
      retrievalDurationMs: Math.round(performance.now() - started),
      retrievalStats: retrieval.stats,
    };
    byId.set(id, record);
    writeJson(path, [...byId.values()]);
    console.error(`[search] ${position + 1}/${questions.length} ${id}`);
  }
  return questions.map((question) => byId.get(questionId(question)));
}

async function answerAndJudge(searches, questions) {
  const path = join(opts.output, "results.json");
  const existing = readArray(path);
  const byId = new Map(existing.map((item) => [item.id, item]));
  let completed = byId.size;
  const pending = questions
    .map((question, index) => ({ question, search: searches[index] }))
    .filter(({ question }) => !byId.has(questionId(question)));
  await mapLimit(pending, 8, async ({ question, search }) => {
    const id = questionId(question);
    const answerStarted = performance.now();
    const answerPrompt = ANSWER_PROMPT.replace("{context}", search.context).replace(
      "{question}",
      question.question,
    );
    const answerResponse = await openRouterChat({
      model: opts.answerModel,
      messages: [{ role: "user", content: answerPrompt }],
      maxTokens: 256,
    });
    const answerDurationMs = Math.round(performance.now() - answerStarted);
    const judgeStarted = performance.now();
    const judgePrompt = JUDGE_PROMPT.replace("{question}", question.question)
      .replace("{golden_answer}", String(question.answer ?? ""))
      .replace("{response}", answerResponse.content);
    const judgeResponse = await openRouterChat({
      model: opts.judgeModel,
      messages: [
        { role: "system", content: JUDGE_SYSTEM_PROMPT },
        { role: "user", content: judgePrompt },
      ],
      maxTokens: 80,
    });
    const record = {
      id,
      conversationIndex: question.conversationIndex,
      qaIndex: question.qaIndex,
      category: question.category,
      categoryName: CATEGORY_NAMES[question.category],
      question: question.question,
      goldenAnswer: question.answer,
      answer: answerResponse.content,
      correct: parseJudgeLabel(judgeResponse.content),
      evidence: search.evidence,
      foundEvidence: search.foundEvidence,
      retrievalDurationMs: search.retrievalDurationMs,
      answerDurationMs,
      judgeDurationMs: Math.round(performance.now() - judgeStarted),
      answerUsage: answerResponse.usage,
      judgeUsage: judgeResponse.usage,
      answerModelResolved: answerResponse.model,
      judgeModelResolved: judgeResponse.model,
    };
    byId.set(id, record);
    completed++;
    writeJson(path, [...byId.values()]);
    console.error(`[answer+judge] ${completed}/${questions.length} ${id}`);
  });
  return questions.map((question) => byId.get(questionId(question)));
}

async function openRouterChat({ model, messages, maxTokens }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0,
        max_tokens: maxTokens,
        provider: { data_collection: "deny" },
      }),
    });
    if (response.ok) {
      const payload = await response.json();
      const choice = payload.choices?.[0];
      if (!choice?.message || typeof choice.message.content !== "string") {
        throw new Error("OpenRouter returned an invalid chat response");
      }
      return {
        content: choice.message.content.trim(),
        model: payload.model ?? model,
        usage: payload.usage ?? {},
      };
    }
    const body = await response.text();
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      await wait((Number(response.headers.get("retry-after")) || 2 ** attempt) * 1_000);
      continue;
    }
    throw new Error(`OpenRouter ${model} failed (${response.status}): ${body.slice(0, 500)}`);
  }
  throw new Error(`OpenRouter ${model} exhausted retries`);
}

function summarize({ indexing, searches, results, startedAt }) {
  const correct = results.filter((item) => item.correct).length;
  const byCategory = Object.fromEntries(
    [1, 2, 3, 4].map((category) => {
      const rows = results.filter((item) => item.category === category);
      const categoryCorrect = rows.filter((item) => item.correct).length;
      return [
        CATEGORY_NAMES[category],
        {
          questions: rows.length,
          correct: categoryCorrect,
          accuracy: rows.length ? categoryCorrect / rows.length : 0,
          evidenceRecall: evidenceRecall(rows),
        },
      ];
    }),
  );
  const answerUsage = sumUsage(results.map((item) => item.answerUsage));
  const judgeUsage = sumUsage(results.map((item) => item.judgeUsage));
  const openRouterReportedCost = [...results.flatMap((item) => [item.answerUsage, item.judgeUsage])]
    .map((usage) => Number(usage?.cost ?? 0))
    .reduce((sum, cost) => sum + cost, 0);
  return {
    status: "internal pilot — not a public leaderboard result",
    dataset: "LoCoMo locomo10, non-adversarial categories 1–4",
    datasetSha256: sha256(readFileSync(opts.dataset)),
    omnimemEvalCommit: OMNIMEMEVAL_COMMIT,
    sample: {
      rate: opts.sampleRate,
      seed: opts.seed,
      questions: results.length,
      categories: categoryCounts(results),
    },
    configuration: {
      topK: opts.topK,
      graph: opts.graph,
      rerank: opts.rerank,
      answerModelRequested: opts.answerModel,
      judgeModelRequested: opts.judgeModel,
      answerModelsResolved: [...new Set(results.map((item) => item.answerModelResolved))],
      judgeModelsResolved: [...new Set(results.map((item) => item.judgeModelResolved))],
    },
    score: {
      correct,
      questions: results.length,
      accuracy: correct / results.length,
      confidence95: wilsonInterval(correct, results.length),
      evidenceRecall: evidenceRecall(results),
      byCategory,
    },
    efficiency: {
      averageContextCharacters:
        searches.reduce((sum, item) => sum + item.contextCharacters, 0) / searches.length,
      searchLatencyMs: latencySummary(searches.map((item) => item.retrievalDurationMs)),
      answerLatencyMs: latencySummary(results.map((item) => item.answerDurationMs)),
      judgeLatencyMs: latencySummary(results.map((item) => item.judgeDurationMs)),
      answerUsage,
      judgeUsage,
      averageAnswerPromptTokens: answerUsage.prompt_tokens / results.length,
      answerAndJudgeOpenRouterReportedCostUsd: openRouterReportedCost || null,
      answerAndJudgeEstimatedListCostUsd:
        (answerUsage.prompt_tokens * 0.4 + answerUsage.completion_tokens * 1.6) / 1_000_000 +
        (judgeUsage.prompt_tokens * 0.15 + judgeUsage.completion_tokens * 0.6) / 1_000_000,
      costScope: "Answer and judge calls only; extraction, embedding, and reranking are excluded.",
    },
    indexing,
    startedAt,
    completedAt: new Date().toISOString(),
    artifacts: {
      manifest: join(opts.output, "sample-manifest.json"),
      searches: join(opts.output, "search-results.json"),
      results: join(opts.output, "results.json"),
    },
  };
}

function evidenceRecall(rows) {
  let expected = 0;
  let found = 0;
  for (const row of rows) {
    expected += row.evidence?.length ?? 0;
    found += row.foundEvidence?.length ?? 0;
  }
  return expected ? found / expected : null;
}

function sumUsage(usages) {
  return usages.reduce(
    (sum, usage) => ({
      prompt_tokens: sum.prompt_tokens + Number(usage?.prompt_tokens ?? 0),
      completion_tokens: sum.completion_tokens + Number(usage?.completion_tokens ?? 0),
      total_tokens: sum.total_tokens + Number(usage?.total_tokens ?? 0),
    }),
    { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  );
}

function latencySummary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    mean: Math.round(sorted.reduce((sum, value) => sum + value, 0) / (sorted.length || 1)),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  };
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function wilsonInterval(successes, total) {
  if (total === 0) return { low: 0, high: 0 };
  const z = 1.96;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin =
    (z / denominator) * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return { low: center - margin, high: center + margin };
}

async function mapLimit(items, limit, visit) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      await visit(items[index], index);
    }
  });
  await Promise.all(workers);
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readArray(path) {
  if (!existsSync(path)) return [];
  const value = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(value) ? value : [];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function md5(value) {
  return createHash("md5").update(value).digest("hex");
}

async function loadReadyDocuments(database, modelId) {
  return database.withClient(async (client) => {
    const collectionIds = Array.from({ length: 10 }, (_, index) => collectionId(index));
    const rows = (
      await client.query(
        `SELECT d.collection_id, d.external_id, d.content_hash, d.extraction_id,
                count(ch.id) > 0 AND count(e.entity_id) = count(ch.id) AS embedded
           FROM retrieval_documents d
           LEFT JOIN retrieval_chunks ch ON ch.document_id = d.id
           LEFT JOIN embeddings e
             ON e.collection_id = ch.collection_id
            AND e.source = 'retrieval_chunk'
            AND e.entity_id = ch.id
            AND e.model_id = $2
          WHERE d.collection_id = ANY($1::text[])
          GROUP BY d.id, d.collection_id, d.external_id, d.content_hash, d.extraction_id`,
        [collectionIds, modelId],
      )
    ).rows;
    return new Map(
      rows.map((row) => [
        `${row.collection_id}\n${row.external_id}`,
        {
          contentHash: row.content_hash,
          extractionId: row.extraction_id,
          embedded: row.embedded,
        },
      ]),
    );
  });
}

async function retrievalCounts(database) {
  return database.withClient(async (client) => {
    const collectionIds = Array.from({ length: 10 }, (_, index) => collectionId(index));
    const counts = {};
    for (const [name, table] of [
      ["chunks", "retrieval_chunks"],
      ["entities", "retrieval_entities"],
      ["relationships", "retrieval_relations"],
    ]) {
      counts[name] = Number(
        (
          await client.query(
            `SELECT count(*) AS count FROM ${table} WHERE collection_id = ANY($1::text[])`,
            [collectionIds],
          )
        ).rows[0].count,
      );
    }
    return counts;
  });
}
