import type { PoolClient } from "@doco/db";
import type { RetrievalStore } from "@doco/index/qdrant-vector-store";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import { applyChangeset } from "../changesets.js";
import { createCollectionInWorkspace } from "../host.js";
import { initializeSingleWorkspace } from "../single-workspace.js";
import { searchWorkspaceRecords } from "../workspace-search.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;

async function fixture() {
  const setup = await initializeSingleWorkspace(client(), {
    workspaceHandle: "acme",
    workspaceName: "Acme",
    ownerEmail: "owner@example.com",
    ownerUsername: "owner",
    ownerName: "Acme Owner",
    ownerPasswordHash: "scrypt$salt$key",
  });
  const collection = await createCollectionInWorkspace(
    {
      workspaceId: setup.workspace.id,
      requestedHandle: "handbook",
      createdByUserId: setup.owner.id,
      templateHandle: "documents",
    },
    client(),
  );
  const captured = await applyChangeset(client(), {
    collectionHandle: collection.handle,
    actorId: setup.owner.id,
    operations: [
      {
        op: "create",
        node_type: "reference",
        body: {
          lifecycle: "drafting",
          prose: "Incident response handbook\nUse the Aurora runbook during database incidents.",
          locator: "https://example.test/runbooks/aurora",
        },
      },
      {
        op: "create",
        node_type: "reference",
        body: {
          lifecycle: "drafting",
          prose: "Adopt PostgreSQL backups\nKeep daily custom-format dumps for recovery.",
        },
      },
    ],
  });
  return { setup, collection, captured };
}

describe("deterministic workspace search", () => {
  it("finds newly authored records without an embedding or indexing pass", async () => {
    const { setup, collection, captured } = await fixture();

    const results = await searchWorkspaceRecords(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      query: "Aurora incidents",
    });

    expect(results).toEqual([
      expect.objectContaining({
        id: captured.results[0]?.id,
        collection_handle: collection.handle,
        node_type: "reference",
        title: "Incident response handbook",
        locator: "https://example.test/runbooks/aurora",
      }),
    ]);
  });

  it("uses stable ordering and exact identifiers while respecting membership", async () => {
    const { setup, captured } = await fixture();
    const firstId = String(captured.results[0]?.id);

    await expect(
      searchWorkspaceRecords(client(), {
        workspaceId: setup.workspace.id,
        userId: "user_01J00000000000000000000000",
        query: "PostgreSQL",
      }),
    ).resolves.toEqual([]);

    await expect(
      searchWorkspaceRecords(client(), {
        workspaceId: setup.workspace.id,
        userId: setup.owner.id,
        query: firstId,
      }),
    ).resolves.toEqual([expect.objectContaining({ id: firstId })]);

    await expect(
      searchWorkspaceRecords(client(), {
        workspaceId: setup.workspace.id,
        userId: setup.owner.id,
        query: "   ",
      }),
    ).resolves.toEqual([]);
  });

  it("uses the Qdrant projection to expand results inside the authorized workspace", async () => {
    const { setup, collection, captured } = await fixture();
    const target = {
      upsert: vi.fn(async () => undefined),
      deletePoints: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      rank: vi.fn(async () => []),
      rankLexical: vi.fn(async () => [
        {
          collection_id: collection.collectionId,
          entity_id: String(captured.results[0]?.id),
          chunk_text: "Incident response handbook",
          score: 4.2,
        },
      ]),
    } satisfies RetrievalStore;

    const results = await searchWorkspaceRecords(
      client(),
      {
        workspaceId: setup.workspace.id,
        userId: setup.owner.id,
        query: "operational continuity",
      },
      { retrievalStore: target },
    );

    expect(target.rankLexical).toHaveBeenCalledWith({
      collectionIds: expect.arrayContaining([collection.collectionId]),
      source: "node",
      queryText: "operational continuity",
      limit: 60,
    });
    expect(results).toEqual([
      expect.objectContaining({
        id: captured.results[0]?.id,
        collection_handle: collection.handle,
      }),
    ]);
  });

  it("keeps PostgreSQL search available while Qdrant is unavailable", async () => {
    const { setup, captured } = await fixture();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const target = {
      ensureCollection: vi.fn(async () => ({ created: false })),
      upsert: vi.fn(async () => {
        throw new Error("Qdrant unavailable");
      }),
      deletePoints: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      rank: vi.fn(async () => []),
      rankLexical: vi.fn(async () => []),
    } satisfies RetrievalStore;

    await expect(
      searchWorkspaceRecords(
        client(),
        {
          workspaceId: setup.workspace.id,
          userId: setup.owner.id,
          query: "Aurora incidents",
        },
        { retrievalStore: target },
      ),
    ).resolves.toEqual([expect.objectContaining({ id: captured.results[0]?.id })]);
    expect(warning).toHaveBeenCalledWith(
      "Qdrant search projection is unavailable; using PostgreSQL search.",
      "Qdrant unavailable",
    );
    warning.mockRestore();
  });
});
