// Chunk embeddings against the real schema and pgvector in PGlite: per-chunk
// hash gating, trimming, pruning by source, model isolation, and ranking by
// the nearest chunk of each entity.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteEmbeddings, rankEmbeddings, upsertEmbeddings } from "../embeddings.js";
import { freshDb } from "./fresh-db.js";

const DOCO = "doco_test0000000000000000000000";
const ORG = "workspace_test000000000000000";

/** A fake provider: a text's vector points along the axis of the first
 *  fruit it names (apple, banana, cherry), so distances are predictable. */
const AXES = ["apple", "banana", "cherry"];
function fakeProvider(modelId = "test:model") {
  const calls: string[][] = [];
  return {
    modelId,
    dimensions: 3,
    calls,
    async embed(texts: string[]): Promise<Float32Array[]> {
      calls.push(texts);
      return texts.map((text) => {
        const v = new Float32Array(3);
        const axis = AXES.findIndex((fruit) => text.toLowerCase().includes(fruit));
        v[axis === -1 ? 2 : axis] = 1;
        return v;
      });
    },
  };
}

let db: PGlite;
type Client = Parameters<typeof upsertEmbeddings>[0];
const client = () => db as unknown as Client;
const input = (entity_id: string, chunks: string[], source: "node" | "notion" = "node") => ({
  source,
  entity_id,
  doco_id: DOCO,
  chunks,
});

async function rows() {
  return (
    await db.query<{
      source: string;
      entity_id: string;
      chunk_index: number;
      model_id: string;
      chunk_text: string;
    }>(
      `SELECT source, entity_id, chunk_index, model_id, chunk_text
         FROM embeddings ORDER BY entity_id, chunk_index`,
    )
  ).rows;
}

beforeEach(async () => {
  db = await freshDb();
  await db.query("INSERT INTO workspaces (id, handle, name) VALUES ($1, 'w', 'W')", [ORG]);
  await db.query(
    "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ($1, 'd', $2, $2, '{}')",
    [DOCO, ORG],
  );
});

describe("upsertEmbeddings", () => {
  it("writes one row per chunk and skips unchanged chunks next time", async () => {
    const provider = fakeProvider();
    const report = await upsertEmbeddings(
      client(),
      [input("decision_1", ["apple pie", "banana bread"])],
      provider,
    );
    expect(report).toMatchObject({ computed: 2, skipped: 0, pruned: 0, modelId: "test:model" });
    expect((await rows()).map((r) => [r.entity_id, r.chunk_index, r.chunk_text])).toEqual([
      ["decision_1", 0, "apple pie"],
      ["decision_1", 1, "banana bread"],
    ]);

    const again = await upsertEmbeddings(
      client(),
      [input("decision_1", ["apple pie", "banana split"])],
      provider,
    );
    expect(again).toMatchObject({ computed: 1, skipped: 1 });
    expect(provider.calls.at(-1)).toEqual(["banana split"]);
  });

  it("drops the chunks a shorter text no longer has, and every chunk of an emptied one", async () => {
    const provider = fakeProvider();
    await upsertEmbeddings(
      client(),
      [input("decision_1", ["apple", "banana", "cherry"])],
      provider,
    );
    await upsertEmbeddings(client(), [input("decision_1", ["apple"])], provider);
    expect((await rows()).map((r) => r.chunk_index)).toEqual([0]);

    await upsertEmbeddings(client(), [input("decision_1", [" "])], provider);
    expect(await rows()).toEqual([]);
  });

  it("re-embeds rows written by another model", async () => {
    await upsertEmbeddings(client(), [input("decision_1", ["apple"])], fakeProvider("old:model"));
    const report = await upsertEmbeddings(
      client(),
      [input("decision_1", ["apple"])],
      fakeProvider("new:model"),
    );
    expect(report).toMatchObject({ computed: 1, skipped: 0 });
    expect((await rows()).map((r) => r.model_id)).toEqual(["new:model"]);
  });

  it("prunes stale entities of the inputs' source only", async () => {
    const provider = fakeProvider();
    await upsertEmbeddings(
      client(),
      [
        input("decision_1", ["apple"]),
        input("decision_2", ["banana"]),
        input("page_1", ["cherry"], "notion"),
      ],
      provider,
    );
    const report = await upsertEmbeddings(client(), [input("decision_1", ["apple"])], provider, {
      pruneStale: true,
    });
    expect(report).toMatchObject({ computed: 0, skipped: 1, pruned: 1 });
    expect((await rows()).map((r) => r.entity_id)).toEqual(["decision_1", "page_1"]);
  });
});

describe("rankEmbeddings", () => {
  beforeEach(async () => {
    await upsertEmbeddings(
      client(),
      [
        input("decision_1", ["cherry tart", "apple pie"]),
        input("decision_2", ["banana bread"]),
        input("page_1", ["apple orchard"], "notion"),
      ],
      fakeProvider(),
    );
    await upsertEmbeddings(client(), [input("decision_old", ["apple"])], fakeProvider("old:model"));
  });

  it("returns each entity's best chunk, best first, for one source and the query's model", async () => {
    const hits = await rankEmbeddings(client(), {
      docoIds: [DOCO],
      source: "node",
      modelId: "test:model",
      queryEmbedding: Float32Array.from([0.9, 0.1, 0]),
      limit: 10,
    });
    expect(hits.map((h) => [h.entity_id, h.chunk_text])).toEqual([
      ["decision_1", "apple pie"],
      ["decision_2", "banana bread"],
    ]);
    expect(hits[0].score).toBeCloseTo(0.9 / Math.hypot(0.9, 0.1), 3);
    expect(hits[1].score).toBeCloseTo(0.1 / Math.hypot(0.9, 0.1), 3);
  });

  it("narrows to the candidate entities, and returns nothing for an empty candidate set", async () => {
    const base = {
      docoIds: [DOCO],
      source: "node" as const,
      modelId: "test:model",
      queryEmbedding: [1, 0, 0],
      limit: 10,
    };
    const only = await rankEmbeddings(client(), { ...base, entityIds: ["decision_2"] });
    expect(only.map((h) => h.entity_id)).toEqual(["decision_2"]);
    expect(await rankEmbeddings(client(), { ...base, entityIds: [] })).toEqual([]);
    expect(await rankEmbeddings(client(), { ...base, docoIds: [] })).toEqual([]);
  });
});

describe("deleteEmbeddings", () => {
  it("deletes the named entities of a source, or the whole source", async () => {
    await upsertEmbeddings(
      client(),
      [
        input("decision_1", ["apple"]),
        input("decision_2", ["banana"]),
        input("page_1", ["cherry"], "notion"),
      ],
      fakeProvider(),
    );
    expect(await deleteEmbeddings(client(), DOCO, "node", ["decision_1"])).toBe(1);
    expect(await deleteEmbeddings(client(), DOCO, "node", [])).toBe(0);
    expect((await rows()).map((r) => r.entity_id)).toEqual(["decision_2", "page_1"]);
    expect(await deleteEmbeddings(client(), DOCO, "notion")).toBe(1);
    expect((await rows()).map((r) => r.entity_id)).toEqual(["decision_2"]);
  });
});
