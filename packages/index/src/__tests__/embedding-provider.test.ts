import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CohereEmbeddingProvider,
  NoopEmbeddingProvider,
  OpenAIEmbeddingProvider,
  VoyageEmbeddingProvider,
  assertLatin1ApiKey,
  getDefaultEmbeddingProvider,
} from "../embedding-provider.js";

/** Capture the last fetch call and return a canned JSON body. */
function stubFetch(body: unknown): { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    }),
  );
  return { calls };
}

function lastBody(calls: { init: RequestInit }[]): Record<string, unknown> {
  return JSON.parse(String(calls[calls.length - 1].init.body));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("assertLatin1ApiKey", () => {
  it("accepts an ASCII key", () => {
    expect(() => assertLatin1ApiKey("sk-abc_123", "OPENAI_API_KEY")).not.toThrow();
  });

  it("names the offending codepoint and index for a corrupt key", () => {
    // U+2014 EM DASH substituted for a hyphen at index 2.
    expect(() => assertLatin1ApiKey("sk—x", "VOYAGE_API_KEY")).toThrow(
      /VOYAGE_API_KEY contains non-ASCII character U\+2014 at index 2/,
    );
  });
});

describe("OpenAIEmbeddingProvider", () => {
  it("is symmetric: accepts inputType but does not send input_type", async () => {
    const { calls } = stubFetch({ data: [{ embedding: [0.1, 0.2] }] });
    const p = new OpenAIEmbeddingProvider("sk-test");
    const out = await p.embed(["hello"], "query");
    expect(out).toHaveLength(1);
    expect(Array.from(out[0])).toEqual([expect.closeTo(0.1, 5), expect.closeTo(0.2, 5)]);
    const body = lastBody(calls);
    expect(body.model).toBe("text-embedding-3-small");
    expect(body.input).toEqual(["hello"]);
    expect(body).not.toHaveProperty("input_type");
  });

  it("throws a descriptive error on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 429, text: async () => "rate limited" }) as Response),
    );
    const p = new OpenAIEmbeddingProvider("sk-test");
    await expect(p.embed(["x"])).rejects.toThrow(/OpenAI embedding request failed \(429\)/);
  });
});

describe("VoyageEmbeddingProvider", () => {
  it("sends input_type and realigns rows by index", async () => {
    // Return rows out of order to prove the defensive sort.
    const { calls } = stubFetch({
      data: [
        { embedding: [9, 9], index: 1 },
        { embedding: [1, 1], index: 0 },
      ],
    });
    const p = new VoyageEmbeddingProvider("va-test");
    const out = await p.embed(["a", "b"], "document");
    expect(Array.from(out[0])).toEqual([1, 1]);
    expect(Array.from(out[1])).toEqual([9, 9]);
    const body = lastBody(calls);
    expect(body.model).toBe("voyage-3.5");
    expect(body.input_type).toBe("document");
    expect(calls[0].url).toBe("https://api.voyageai.com/v1/embeddings");
  });

  it("omits input_type when none is given", async () => {
    const { calls } = stubFetch({ data: [{ embedding: [0], index: 0 }] });
    await new VoyageEmbeddingProvider("va-test").embed(["a"]);
    expect(lastBody(calls)).not.toHaveProperty("input_type");
  });
});

describe("CohereEmbeddingProvider", () => {
  it("maps query→search_query and parses embeddings.float", async () => {
    const { calls } = stubFetch({ embeddings: { float: [[0.5, 0.6]] } });
    const p = new CohereEmbeddingProvider("co-test");
    const out = await p.embed(["q"], "query");
    expect(Array.from(out[0])).toEqual([expect.closeTo(0.5, 5), expect.closeTo(0.6, 5)]);
    const body = lastBody(calls);
    expect(body.model).toBe("embed-v4.0");
    expect(body.input_type).toBe("search_query");
    expect(body.embedding_types).toEqual(["float"]);
  });

  it("defaults an unspecified call to search_document", async () => {
    const { calls } = stubFetch({ embeddings: { float: [[0]] } });
    await new CohereEmbeddingProvider("co-test").embed(["d"]);
    expect(lastBody(calls).input_type).toBe("search_document");
  });
});

describe("getDefaultEmbeddingProvider", () => {
  it("returns Noop when no key is set", () => {
    expect(getDefaultEmbeddingProvider()).toBeInstanceOf(NoopEmbeddingProvider);
  });

  it("prefers OpenAI implicitly when Voyage is also set", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("VOYAGE_API_KEY", "va-test");
    expect(getDefaultEmbeddingProvider()).toBeInstanceOf(OpenAIEmbeddingProvider);
  });

  it("uses a Voyage key implicitly when OpenAI's is absent", () => {
    vi.stubEnv("VOYAGE_API_KEY", "va-test");
    expect(getDefaultEmbeddingProvider()).toBeInstanceOf(VoyageEmbeddingProvider);
  });

  it("honors an explicit DOCO_EMBEDDING_PROVIDER selector", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("VOYAGE_API_KEY", "va-test");
    vi.stubEnv("DOCO_EMBEDDING_PROVIDER", "voyage");
    expect(getDefaultEmbeddingProvider()).toBeInstanceOf(VoyageEmbeddingProvider);
  });

  it("forces Cohere when selected", () => {
    vi.stubEnv("COHERE_API_KEY", "co-test");
    vi.stubEnv("DOCO_EMBEDDING_PROVIDER", "cohere");
    expect(getDefaultEmbeddingProvider()).toBeInstanceOf(CohereEmbeddingProvider);
  });

  it("falls back to Noop when the selected provider's key is missing", () => {
    vi.stubEnv("DOCO_EMBEDDING_PROVIDER", "voyage");
    expect(getDefaultEmbeddingProvider()).toBeInstanceOf(NoopEmbeddingProvider);
  });

  it("'none' disables embeddings even with a key present", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("DOCO_EMBEDDING_PROVIDER", "none");
    expect(getDefaultEmbeddingProvider()).toBeInstanceOf(NoopEmbeddingProvider);
  });

  it("treats a corrupt key as no provider (Noop), not a crash", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk—corrupt");
    expect(getDefaultEmbeddingProvider()).toBeInstanceOf(NoopEmbeddingProvider);
  });
});

// The brief's deadline stops a query embedding that is still in flight.
describe("abort signal", () => {
  it.each([
    ["OpenAI", () => new OpenAIEmbeddingProvider("sk-test"), { data: [{ embedding: [0] }] }],
    ["Voyage", () => new VoyageEmbeddingProvider("va-test"), { data: [{ embedding: [0] }] }],
    ["Cohere", () => new CohereEmbeddingProvider("co-test"), { embeddings: { float: [[0]] } }],
  ])("%s passes the caller's signal to its request", async (_name, make, body) => {
    const { calls } = stubFetch(body);
    const signal = new AbortController().signal;
    await make().embed(["q"], "query", signal);
    expect(calls[0].init.signal).toBe(signal);
  });
});
