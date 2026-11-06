import { createHash } from "node:crypto";
import { resolve } from "node:path";

const EVALUATED_CATEGORIES = new Set([1, 2, 3, 4]);

export function parseBenchmarkArgs(argv, env = process.env) {
  const parsed = {
    dataset: "",
    databaseUrl: env.DOCO_BENCHMARK_DATABASE_URL ?? "",
    output: resolve("locomo-pilot-results"),
    sampleRate: 0.1,
    seed: "doco-locomo-pilot-v1",
    topK: 20,
    graph: true,
    rerank: true,
    answerModel: "openai/gpt-4.1-mini",
    judgeModel: "openai/gpt-4o-mini",
    acceptedLicense: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") continue;
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--dataset") parsed.dataset = resolve(next());
    else if (arg === "--database-url") parsed.databaseUrl = next();
    else if (arg === "--output") parsed.output = resolve(next());
    else if (arg === "--sample-rate") parsed.sampleRate = Number(next());
    else if (arg === "--seed") parsed.seed = next();
    else if (arg === "--top-k") parsed.topK = Number(next());
    else if (arg === "--answer-model") parsed.answerModel = next();
    else if (arg === "--judge-model") parsed.judgeModel = next();
    else if (arg === "--no-graph") parsed.graph = false;
    else if (arg === "--no-rerank") parsed.rerank = false;
    else if (arg === "--accept-noncommercial-license") parsed.acceptedLicense = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!parsed.acceptedLicense) {
    throw new Error(
      "Pass --accept-noncommercial-license after reviewing LoCoMo's CC BY-NC 4.0 license",
    );
  }
  if (!parsed.dataset) throw new Error("Pass --dataset with locomo10.json");
  if (!parsed.databaseUrl) {
    throw new Error("Set DOCO_BENCHMARK_DATABASE_URL or pass --database-url");
  }
  const database = new URL(parsed.databaseUrl).pathname.slice(1).toLowerCase();
  if (!database.includes("locomo") && !database.includes("benchmark")) {
    throw new Error("Refusing to use a database whose name is not benchmark-specific");
  }
  if (!(parsed.sampleRate > 0 && parsed.sampleRate <= 1)) {
    throw new Error("--sample-rate must be greater than 0 and at most 1");
  }
  if (!Number.isInteger(parsed.topK) || parsed.topK < 1 || parsed.topK > 50) {
    throw new Error("--top-k must be an integer from 1 to 50");
  }
  if (!env.OPENROUTER_API_KEY && !env.OPEN_ROUTER_API_KEY) {
    throw new Error("Set OPENROUTER_API_KEY");
  }
  if (!env.VOYAGE_API_KEY) throw new Error("Set VOYAGE_API_KEY");
  return parsed;
}

function stableKey(seed, ...parts) {
  return createHash("sha256")
    .update([seed, ...parts].join("\u0000"))
    .digest("hex");
}

export function flattenQuestions(dataset) {
  return dataset.flatMap((sample, conversationIndex) =>
    (sample.qa ?? [])
      .map((qa, qaIndex) => ({ ...qa, conversationIndex, qaIndex }))
      .filter((qa) => EVALUATED_CATEGORIES.has(Number(qa.category)))
      .map((qa) => ({ ...qa, category: Number(qa.category) })),
  );
}

function categoryQuotas(items, rate) {
  const counts = new Map();
  for (const item of items) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  const target = Math.round(items.length * rate);
  const rows = [...counts.entries()].map(([category, count]) => {
    const exact = count * rate;
    return { category, count, quota: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remaining = target - rows.reduce((sum, row) => sum + row.quota, 0);
  rows.sort((left, right) => right.remainder - left.remainder || left.category - right.category);
  for (const row of rows) {
    if (remaining <= 0) break;
    if (row.quota < row.count) {
      row.quota++;
      remaining--;
    }
  }
  return new Map(rows.map((row) => [row.category, row.quota]));
}

function selectCategory(items, quota, seed, category) {
  const byConversation = new Map();
  for (const item of items) {
    const group = byConversation.get(item.conversationIndex) ?? [];
    group.push(item);
    byConversation.set(item.conversationIndex, group);
  }
  for (const [conversationIndex, group] of byConversation) {
    group.sort((left, right) =>
      stableKey(seed, category, conversationIndex, left.qaIndex, left.question).localeCompare(
        stableKey(seed, category, conversationIndex, right.qaIndex, right.question),
      ),
    );
  }
  const conversationOrder = [...byConversation.keys()].sort((left, right) =>
    stableKey(seed, category, left).localeCompare(stableKey(seed, category, right)),
  );
  const selected = [];
  while (selected.length < quota) {
    let added = 0;
    for (const conversationIndex of conversationOrder) {
      const next = byConversation.get(conversationIndex)?.shift();
      if (!next) continue;
      selected.push(next);
      added++;
      if (selected.length === quota) break;
    }
    if (added === 0) break;
  }
  return selected;
}

export function selectStratifiedQuestions(dataset, { rate = 0.1, seed }) {
  const items = flattenQuestions(dataset);
  const quotas = categoryQuotas(items, rate);
  const selected = [];
  for (const [category, quota] of [...quotas.entries()].sort(([left], [right]) => left - right)) {
    selected.push(
      ...selectCategory(
        items.filter((item) => item.category === category),
        quota,
        seed,
        category,
      ),
    );
  }
  return selected.sort(
    (left, right) =>
      left.conversationIndex - right.conversationIndex || left.qaIndex - right.qaIndex,
  );
}

export function categoryCounts(items) {
  return Object.fromEntries(
    [...new Set(items.map((item) => item.category))]
      .sort((left, right) => left - right)
      .map((category) => [category, items.filter((item) => item.category === category).length]),
  );
}

function imageCaption(chat) {
  const caption = chat.blip_captions ?? chat.blip_caption;
  if (Array.isArray(caption)) return caption.filter(Boolean).join("; ");
  return typeof caption === "string" ? caption.trim() : "";
}

export function formatSessionDocument(conversation, conversationIndex, sessionIndex) {
  const sessionKey = `session_${sessionIndex}`;
  const session = conversation[sessionKey];
  if (!Array.isArray(session)) return null;
  const date = conversation[`${sessionKey}_date_time`] ?? "unknown date";
  const speakerA = conversation.speaker_a ?? "Speaker A";
  const speakerB = conversation.speaker_b ?? "Speaker B";
  const lines = session.map((chat, turnIndex) => {
    const id = chat.dia_id ?? `${sessionKey}:${turnIndex}`;
    const speaker = chat.speaker ?? "Unknown speaker";
    const caption = imageCaption(chat);
    return `${id} | ${speaker}: ${chat.text ?? ""}${caption ? ` [Image: ${caption}]` : ""}`;
  });
  return {
    externalId: `conv-${conversationIndex}:${sessionKey.replace("_", "-")}`,
    source: "locomo",
    locator: `locomo://conv-${conversationIndex}/${sessionKey.replace("_", "-")}`,
    title: `${speakerA} and ${speakerB} — ${date}`,
    content: `Conversation between ${speakerA} and ${speakerB}\nDate: ${date}\n\n${lines.join("\n")}`,
  };
}

export function parseJudgeLabel(text) {
  const match = String(text).match(/\{[\s\S]*?\}/);
  if (!match) throw new Error("Could not extract judge label");
  let payload;
  try {
    payload = JSON.parse(match[0]);
  } catch {
    throw new Error("Could not extract judge label");
  }
  const label = String(payload.label ?? "")
    .trim()
    .toUpperCase();
  if (label === "CORRECT") return true;
  if (label === "WRONG") return false;
  throw new Error("Could not extract judge label");
}
