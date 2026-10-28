import { posix, resolve } from "node:path";

const DATASET_ID = /(?:^|[^a-z0-9])(dsid_[a-z0-9]+)(?=[^a-z0-9]|$)/i;

export function parseBenchmarkArgs(argv, env = process.env) {
  const parsed = {
    archives: [],
    questions: "",
    output: resolve("enterprise-rag-answers.jsonl"),
    databaseUrl: env.DOCO_BENCHMARK_DATABASE_URL ?? "",
    topK: 10,
    eligibleOnly: false,
    answers: false,
    graph: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--archive") parsed.archives.push(resolve(next()));
    else if (arg === "--questions") parsed.questions = resolve(next());
    else if (arg === "--output") parsed.output = resolve(next());
    else if (arg === "--database-url") parsed.databaseUrl = next();
    else if (arg === "--top-k") parsed.topK = Number(next());
    else if (arg === "--eligible-only") parsed.eligibleOnly = true;
    else if (arg === "--answers") parsed.answers = true;
    else if (arg === "--graph") parsed.graph = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (parsed.archives.length === 0) throw new Error("Pass at least one --archive");
  if (!parsed.questions) throw new Error("Pass --questions");
  if (!parsed.databaseUrl) {
    throw new Error("Set DOCO_BENCHMARK_DATABASE_URL or pass --database-url");
  }
  const database = new URL(parsed.databaseUrl).pathname.slice(1).toLowerCase();
  if (!database.includes("enterprise") && !database.includes("benchmark")) {
    throw new Error("Refusing to use a database whose name is not benchmark-specific");
  }
  if (!Number.isInteger(parsed.topK) || parsed.topK < 1 || parsed.topK > 50) {
    throw new Error("--top-k must be an integer from 1 to 50");
  }
  if (parsed.answers && !env.ANTHROPIC_API_KEY) {
    throw new Error("--answers requires ANTHROPIC_API_KEY");
  }
  return parsed;
}

export function parseBenchmarkDocument(entryName, rawText, sourceHint) {
  const path = entryName.replaceAll("\\", "/").replace(/^\.\//, "");
  const id = DATASET_ID.exec(posix.basename(path))?.[1];
  if (!id) throw new Error(`Benchmark entry has no dataset document id: ${entryName}`);

  const source = sourceHint?.trim() || path.split("/")[0]?.trim();
  if (!source || source === posix.basename(path)) {
    throw new Error(`Benchmark entry has no source identity: ${entryName}`);
  }

  const normalized = rawText.replace(/\r\n?/g, "\n").trim();
  if (!normalized) throw new Error(`Benchmark document ${id} is blank`);
  const lines = normalized.split("\n");
  const title = lines.shift()?.trim() || null;
  const body = lines.join("\n").trim();

  return {
    externalId: id,
    source,
    locator: `enterpriserag://${path}`,
    title,
    content: body || title,
  };
}

export function runnableQuestions(questions, indexedDocumentIds) {
  return questions.filter(
    (question) =>
      question.expected_doc_ids.length > 0 &&
      question.expected_doc_ids.every((id) => indexedDocumentIds.has(id)),
  );
}

export function dedupeRankedDocuments(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.externalId)) return false;
    seen.add(item.externalId);
    return true;
  });
}

export function retrievalSummary(cases) {
  const scored = cases.filter((item) => item.expected.length > 0);
  if (scored.length === 0) {
    return { questions: 0, documentRecall: 0, completeRecall: 0, hitRate: 0, mrr: 0 };
  }
  let documentRecall = 0;
  let completeRecall = 0;
  let hitRate = 0;
  let mrr = 0;
  for (const item of scored) {
    const expected = new Set(item.expected);
    const retrieved = item.retrieved;
    const found = [...expected].filter((id) => retrieved.includes(id)).length;
    documentRecall += expected.size === 0 ? 0 : found / expected.size;
    completeRecall += expected.size > 0 && found === expected.size ? 1 : 0;
    hitRate += found > 0 ? 1 : 0;
    const first = retrieved.findIndex((id) => expected.has(id));
    mrr += first < 0 ? 0 : 1 / (first + 1);
  }
  const n = scored.length;
  return {
    questions: n,
    documentRecall: documentRecall / n,
    completeRecall: completeRecall / n,
    hitRate: hitRate / n,
    mrr: mrr / n,
  };
}
