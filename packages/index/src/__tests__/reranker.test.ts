import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CohereReranker,
  NoopReranker,
  VoyageReranker,
  getDefaultReranker,
  rerankItems,
} from "../reranker.js";

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

describe("NoopReranker", () => {
  it("preserves order and honors topN", async () => {
    const r = await new NoopReranker().rerank("q", ["a", "b", "c"], 2);
    expect(r).toEqual([
      { index: 0, score: 0 },
      { index: 1, score: 0 },
    ]);
  });
});

describe("CohereReranker", () => {
  it("sends top_n and normalizes relevance_score → score", async () => {
    const { calls } = stubFetch({
      results: [
        { index: 2, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.4 },
      ],
    });
    const out = await new CohereReranker("co-test").rerank("q", ["a", "b", "c"], 2);
    expect(out).toEqual([
      { index: 2, score: 0.9 },
      { index: 0, score: 0.4 },
    ]);
    const body = lastBody(calls);
    expect(body.model).toBe("rerank-v3.5");
    expect(body.query).toBe("q");
    expect(body.top_n).toBe(2);
    expect(calls[0].url).toBe("https://api.cohere.com/v2/rerank");
  });

  it("short-circuits an empty document set without calling fetch", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await new CohereReranker("co-test").rerank("q", [])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("VoyageReranker", () => {
  it("sends top_k and sorts results by descending score", async () => {
    const { calls } = stubFetch({
      data: [
        { index: 0, relevance_score: 0.2 },
        { index: 1, relevance_score: 0.8 },
      ],
    });
    const out = await new VoyageReranker("va-test").rerank("q", ["a", "b"], 5);
    expect(out).toEqual([
      { index: 1, score: 0.8 },
      { index: 0, score: 0.2 },
    ]);
    expect(lastBody(calls).top_k).toBe(5);
  });
});

describe("rerankItems", () => {
  it("reorders the original items by rerank result and drops out-of-range", async () => {
    stubFetch({
      results: [
        { index: 2, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.5 },
        { index: 7, relevance_score: 0.1 }, // out of range → dropped
      ],
    });
    const items = [
      { id: "x", text: "alpha" },
      { id: "y", text: "beta" },
      { id: "z", text: "gamma" },
    ];
    const out = await rerankItems(new CohereReranker("co-test"), "q", items, (i) => i.text);
    expect(out.map((o) => o.item.id)).toEqual(["z", "x"]);
    expect(out[0].score).toBe(0.9);
  });

  it("returns [] for no items without calling the reranker", async () => {
    const reranker = { modelId: "spy", rerank: vi.fn() };
    expect(await rerankItems(reranker, "q", [], () => "")).toEqual([]);
    expect(reranker.rerank).not.toHaveBeenCalled();
  });
});

describe("getDefaultReranker", () => {
  it("is OFF by default (no DOCO_RERANK_PROVIDER)", () => {
    expect(getDefaultReranker()).toBeUndefined();
  });

  it("does NOT auto-enable just because COHERE_API_KEY is set", () => {
    vi.stubEnv("COHERE_API_KEY", "co-test");
    expect(getDefaultReranker()).toBeUndefined();
  });

  it("enables Cohere when explicitly selected with a key", () => {
    vi.stubEnv("COHERE_API_KEY", "co-test");
    vi.stubEnv("DOCO_RERANK_PROVIDER", "cohere");
    expect(getDefaultReranker()).toBeInstanceOf(CohereReranker);
  });

  it("enables Voyage when explicitly selected with a key", () => {
    vi.stubEnv("VOYAGE_API_KEY", "va-test");
    vi.stubEnv("DOCO_RERANK_PROVIDER", "voyage");
    expect(getDefaultReranker()).toBeInstanceOf(VoyageReranker);
  });

  it("stays disabled when the selected provider's key is missing", () => {
    vi.stubEnv("DOCO_RERANK_PROVIDER", "cohere");
    expect(getDefaultReranker()).toBeUndefined();
  });
});

// The brief's deadline stops a rerank that is still in flight.
describe("abort signal", () => {
  it.each([
    ["Cohere", () => new CohereReranker("co-test"), { results: [] }],
    ["Voyage", () => new VoyageReranker("va-test"), { data: [] }],
  ])("%s passes the caller's signal to its request", async (_name, make, body) => {
    const { calls } = stubFetch(body);
    const signal = new AbortController().signal;
    await make().rerank("q", ["a"], undefined, signal);
    expect(calls[0].init.signal).toBe(signal);
  });

  it("rerankItems hands the signal to the reranker", async () => {
    const reranker = { modelId: "test", rerank: vi.fn(async () => [{ index: 0, score: 1 }]) };
    const signal = new AbortController().signal;
    await rerankItems(reranker, "q", [{ text: "a" }], (i) => i.text, undefined, signal);
    expect(reranker.rerank).toHaveBeenCalledWith("q", ["a"], undefined, signal);
  });
});
