/**
 * EmbeddingProvider interface per ADR-052. Default: no-op (FTS only). When
 * `OPENAI_API_KEY` is set, the OpenAI provider with text-embedding-3-small
 * is used. Self-hosted users can extend with a local sentence-transformers
 * process — add a new Provider class and a switch in
 * getDefaultEmbeddingProvider.
 *
 * Env-var convention matches Speco: bare provider keys (`OPENAI_API_KEY`,
 * `VOYAGE_API_KEY`, `COHERE_API_KEY`). No Doco-prefixed variant. To pick a
 * provider explicitly when more than one key is present, set
 * `DOCO_EMBEDDING_PROVIDER` to `openai` | `voyage` | `cohere` | `none`.
 *
 * Asymmetric retrieval. Agent queries are short natural-language questions;
 * the corpus is dense typed prose (decisions, rules, intents). That's an
 * asymmetric query→document match, and retrieval-tuned models do measurably
 * better when told which side they're embedding. `embed()` therefore takes
 * an optional `inputType`: the indexer passes `"document"`, the search path
 * passes `"query"`. The param is optional and ignored by symmetric models
 * (OpenAI text-embedding-3-* has no such knob), so every existing
 * single-arg caller keeps working unchanged.
 */

/** Which side of an asymmetric retrieval pair a text is being embedded as. */
export type EmbeddingInputType = "query" | "document";

export interface EmbeddingProvider {
  modelId: string;
  dimensions: number;
  embed(texts: string[], inputType?: EmbeddingInputType): Promise<Float32Array[]>;
}

/**
 * Fail at construction with a message that names the offending codepoint when
 * an API key carries a non-ASCII character. Header values in fetch() must be
 * Latin-1 (ByteString, ≤ U+00FF); a key that picked up a smart-typography
 * substitution on its way into the env (em-dash for hyphen, curly quote for
 * apostrophe, NBSP for space, …) otherwise crashes deep inside undici with
 * "Cannot convert argument to a ByteString", and the error leaks into the
 * user-facing /search.json warning with no hint that the key itself is
 * corrupt. Shared by every provider; exported so the reranker reuses it.
 */
export function assertLatin1ApiKey(apiKey: string, envName: string): void {
  for (let i = 0; i < apiKey.length; i++) {
    const code = apiKey.charCodeAt(i);
    if (code > 0x7f) {
      const hex = code.toString(16).padStart(4, "0").toUpperCase();
      throw new Error(
        `${envName} contains non-ASCII character U+${hex} at index ${i} — likely paste corruption (e.g. "—" for "-"). Re-paste the key from the provider dashboard through a plain-text path.`,
      );
    }
  }
}

export class NoopEmbeddingProvider implements EmbeddingProvider {
  modelId = "noop";
  dimensions = 0;
  async embed(_texts: string[], _inputType?: EmbeddingInputType): Promise<Float32Array[]> {
    return _texts.map(() => new Float32Array(0));
  }
}

/**
 * OpenAI text-embedding-3-small. Lazy-instantiated; doesn't actually call
 * the API until embed() is invoked, so missing-key environments don't fail
 * at import time. Symmetric model: `inputType` is accepted for interface
 * compatibility but has no effect (the API exposes no query/document knob).
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  modelId = "openai:text-embedding-3-small";
  dimensions = 1536;

  constructor(private apiKey: string) {
    assertLatin1ApiKey(apiKey, "OPENAI_API_KEY");
  }

  async embed(texts: string[], _inputType?: EmbeddingInputType): Promise<Float32Array[]> {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: texts,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI embedding request failed (${res.status}): ${text}`);
    }
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => new Float32Array(d.embedding));
  }
}

/**
 * Voyage AI (voyage-3.5 by default). Retrieval-tuned and asymmetric: it
 * takes `input_type: "query" | "document"`, which maps 1:1 onto our
 * `inputType`. Omitting it (undefined) asks Voyage for a neutral embedding —
 * we still send nothing in that case so behavior matches Voyage's default.
 */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  modelId: string;
  dimensions = 1024;

  constructor(
    private apiKey: string,
    model = "voyage-3.5",
  ) {
    assertLatin1ApiKey(apiKey, "VOYAGE_API_KEY");
    this.modelId = `voyage:${model}`;
  }

  private get model(): string {
    return this.modelId.slice("voyage:".length);
  }

  async embed(texts: string[], inputType?: EmbeddingInputType): Promise<Float32Array[]> {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        ...(inputType ? { input_type: inputType } : {}),
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Voyage embedding request failed (${res.status}): ${text}`);
    }
    const json = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    // Voyage returns rows in input order, but sort by `index` defensively so
    // a reordered response can't silently misalign vectors to entities.
    return json.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((d) => new Float32Array(d.embedding));
  }
}

/**
 * Cohere embed-v4.0. Retrieval-tuned and asymmetric via `input_type`, whose
 * values are spelled `search_query` / `search_document`. We map our
 * `inputType` onto those, defaulting an unspecified call to
 * `search_document` because v3+ models require the field and the indexer is
 * the high-volume caller. Response carries embeddings under
 * `embeddings.float` when `embedding_types: ["float"]` is requested.
 */
export class CohereEmbeddingProvider implements EmbeddingProvider {
  modelId: string;
  dimensions = 1536;

  constructor(
    private apiKey: string,
    model = "embed-v4.0",
  ) {
    assertLatin1ApiKey(apiKey, "COHERE_API_KEY");
    this.modelId = `cohere:${model}`;
  }

  private get model(): string {
    return this.modelId.slice("cohere:".length);
  }

  async embed(texts: string[], inputType?: EmbeddingInputType): Promise<Float32Array[]> {
    const cohereInputType = inputType === "query" ? "search_query" : "search_document";
    const res = await fetch("https://api.cohere.com/v2/embed", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        texts,
        input_type: cohereInputType,
        embedding_types: ["float"],
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Cohere embedding request failed (${res.status}): ${text}`);
    }
    const json = (await res.json()) as { embeddings: { float: number[][] } };
    return json.embeddings.float.map((e) => new Float32Array(e));
  }
}

/**
 * Resolve the active provider from the environment. `DOCO_EMBEDDING_PROVIDER`
 * forces a choice; otherwise we auto-detect by key presence, preferring
 * OpenAI when its key is set so existing single-key deployments are
 * unchanged. A Voyage/Cohere key is used implicitly only when OPENAI_API_KEY
 * is absent — to prefer an asymmetric model while the OpenAI key is also set,
 * set `DOCO_EMBEDDING_PROVIDER=voyage` (or `cohere`).
 */
export function getDefaultEmbeddingProvider(): EmbeddingProvider {
  const selector = (process.env.DOCO_EMBEDDING_PROVIDER ?? "").trim().toLowerCase();
  try {
    switch (selector) {
      case "none":
      case "noop":
        return new NoopEmbeddingProvider();
      case "openai":
        return providerForKey("OPENAI_API_KEY", (k) => new OpenAIEmbeddingProvider(k));
      case "voyage":
        return providerForKey("VOYAGE_API_KEY", (k) => new VoyageEmbeddingProvider(k));
      case "cohere":
        return providerForKey("COHERE_API_KEY", (k) => new CohereEmbeddingProvider(k));
      case "":
        break;
      default:
        console.error(
          `[doco/embedding-provider] Unknown DOCO_EMBEDDING_PROVIDER="${selector}"; auto-detecting by key.`,
        );
    }
    if (process.env.OPENAI_API_KEY) return new OpenAIEmbeddingProvider(process.env.OPENAI_API_KEY);
    if (process.env.VOYAGE_API_KEY) return new VoyageEmbeddingProvider(process.env.VOYAGE_API_KEY);
    if (process.env.COHERE_API_KEY) return new CohereEmbeddingProvider(process.env.COHERE_API_KEY);
    return new NoopEmbeddingProvider();
  } catch (e) {
    // Corrupt key (non-ASCII) — treat as "no provider configured" so callers
    // surface the existing "vector search unavailable" path instead of a
    // cryptic ByteString crash on every search. The thrown message names the
    // codepoint and index; log it so the admin can fix the env.
    console.error(`[doco/embedding-provider] ${(e as Error).message}`);
    return new NoopEmbeddingProvider();
  }
}

/**
 * Build a provider from a named env key, or fall back to Noop (with a log)
 * when an explicitly-selected provider's key is missing.
 */
function providerForKey(
  envName: string,
  make: (key: string) => EmbeddingProvider,
): EmbeddingProvider {
  const key = process.env[envName];
  if (!key) {
    console.error(
      `[doco/embedding-provider] DOCO_EMBEDDING_PROVIDER selects ${envName} but it is not set; embeddings disabled.`,
    );
    return new NoopEmbeddingProvider();
  }
  return make(key);
}
