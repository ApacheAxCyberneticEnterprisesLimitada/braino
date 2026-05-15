/**
 * EmbeddingProvider interface per ADR-052. Default: no-op (FTS only). When
 * `OPENAI_API_KEY` is set, the OpenAI provider with text-embedding-3-small
 * is used. Self-hosted users can extend with a local sentence-transformers
 * process — add a new Provider class and a switch in
 * getDefaultEmbeddingProvider.
 *
 * Env-var convention matches Speco: `OPENAI_API_KEY`. No Doco-prefixed
 * variant.
 */

export interface EmbeddingProvider {
  modelId: string;
  dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export class NoopEmbeddingProvider implements EmbeddingProvider {
  modelId = "noop";
  dimensions = 0;
  async embed(_texts: string[]): Promise<Float32Array[]> {
    return _texts.map(() => new Float32Array(0));
  }
}

/**
 * OpenAI text-embedding-3-small. Lazy-instantiated; doesn't actually call
 * the API until embed() is invoked, so missing-key environments don't fail
 * at import time.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  modelId = "openai:text-embedding-3-small";
  dimensions = 1536;

  constructor(private apiKey: string) {
    // Header values in fetch() must be Latin-1 (ByteString, ≤ U+00FF). A key
    // that picked up a smart-typography substitution somewhere on its way
    // into the env (em-dash for hyphen, curly quote for apostrophe, NBSP for
    // space, …) crashes deep inside undici with "Cannot convert argument to
    // a ByteString" — the error leaks into the user-facing /search.json
    // warning and gives no hint that the key itself is corrupt. Fail at
    // construction with a message that names the offending codepoint.
    for (let i = 0; i < apiKey.length; i++) {
      const code = apiKey.charCodeAt(i);
      if (code > 0x7f) {
        const hex = code.toString(16).padStart(4, "0").toUpperCase();
        throw new Error(
          `OPENAI_API_KEY contains non-ASCII character U+${hex} at index ${i} — likely paste corruption (e.g. "—" for "-"). Re-paste the key from the OpenAI dashboard through a plain-text path.`,
        );
      }
    }
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
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

export function getDefaultEmbeddingProvider(): EmbeddingProvider {
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) return new NoopEmbeddingProvider();
  try {
    return new OpenAIEmbeddingProvider(apiKey);
  } catch (e) {
    // Corrupt key (non-ASCII) — treat as "no provider configured" so callers
    // surface the existing "vector search unavailable" path instead of a
    // cryptic ByteString crash on every search. The constructor's message
    // names the codepoint and index; log it so the admin can fix the env.
    console.error(`[doco/embedding-provider] ${(e as Error).message}`);
    return new NoopEmbeddingProvider();
  }
}
