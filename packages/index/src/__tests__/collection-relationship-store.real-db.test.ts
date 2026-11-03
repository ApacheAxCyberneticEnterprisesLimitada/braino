import type { QueryClient } from "@doco/db";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import {
  listCollectionRelationships,
  replaceWorkspaceRelationships,
} from "../collection-relationship-store.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
  await db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES
      ('workspace_one', 'one', 'One'),
      ('workspace_two', 'two', 'Two');
    INSERT INTO collections (id, handle, owner_id, workspace_id, visibility, data) VALUES
      ('collection_alpha', 'alpha', 'workspace_one', 'workspace_one', 'private', '{}'::jsonb),
      ('collection_beta', 'beta', 'workspace_one', 'workspace_one', 'private', '{}'::jsonb),
      ('collection_gamma', 'gamma', 'workspace_one', 'workspace_one', 'private', '{}'::jsonb),
      ('collection_foreign', 'foreign', 'workspace_two', 'workspace_two', 'private', '{}'::jsonb);
  `);
});

const client = () => db as unknown as QueryClient;

describe("collection relationship store", () => {
  it("atomically replaces the workspace graph instead of competing per-anchor slices", async () => {
    await replaceWorkspaceRelationships(client(), {
      workspaceId: "workspace_one",
      relationships: [
        {
          from: "collection_alpha",
          to: "collection_beta",
          type: "depends_on",
          confidence: 0.91,
          evidence: [
            {
              collectionId: "collection_alpha",
              summaryVersion: "alpha-v1",
              evidenceIds: ["decision_alpha"],
            },
            {
              collectionId: "collection_beta",
              summaryVersion: "beta-v1",
              evidenceIds: ["decision_beta"],
            },
          ],
        },
        {
          from: "collection_gamma",
          to: "collection_alpha",
          type: "documents",
          confidence: 0.84,
          evidence: [
            {
              collectionId: "collection_gamma",
              summaryVersion: "gamma-v1",
              evidenceIds: ["decision_gamma"],
            },
            {
              collectionId: "collection_alpha",
              summaryVersion: "alpha-v1",
              evidenceIds: ["decision_alpha"],
            },
          ],
        },
      ],
    });

    await replaceWorkspaceRelationships(client(), {
      workspaceId: "workspace_one",
      relationships: [
        {
          from: "collection_alpha",
          to: "collection_gamma",
          type: "implements",
          confidence: 0.96,
          evidence: [
            {
              collectionId: "collection_alpha",
              summaryVersion: "alpha-v2",
              evidenceIds: ["decision_alpha_2"],
            },
            {
              collectionId: "collection_gamma",
              summaryVersion: "gamma-v1",
              evidenceIds: ["decision_gamma"],
            },
          ],
        },
      ],
    });

    await expect(
      listCollectionRelationships(client(), {
        workspaceId: "workspace_one",
        collectionIds: ["collection_alpha", "collection_beta", "collection_gamma"],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        from: "collection_alpha",
        to: "collection_gamma",
        type: "implements",
      }),
    ]);
  });

  it("returns an edge only when the reader can access both endpoints", async () => {
    await replaceWorkspaceRelationships(client(), {
      workspaceId: "workspace_one",
      relationships: [
        {
          from: "collection_alpha",
          to: "collection_beta",
          type: "depends_on",
          confidence: 0.91,
          evidence: [
            {
              collectionId: "collection_alpha",
              summaryVersion: "alpha-v1",
              evidenceIds: ["decision_alpha"],
            },
            {
              collectionId: "collection_beta",
              summaryVersion: "beta-v1",
              evidenceIds: ["decision_beta"],
            },
          ],
        },
      ],
    });

    await expect(
      listCollectionRelationships(client(), {
        workspaceId: "workspace_one",
        collectionIds: ["collection_alpha"],
      }),
    ).resolves.toEqual([]);
  });

  it("rejects foreign endpoints without deleting the current relationships", async () => {
    await replaceWorkspaceRelationships(client(), {
      workspaceId: "workspace_one",
      relationships: [],
    });

    await expect(
      replaceWorkspaceRelationships(client(), {
        workspaceId: "workspace_one",
        relationships: [
          {
            from: "collection_alpha",
            to: "collection_foreign",
            type: "depends_on",
            confidence: 0.8,
            evidence: [
              {
                collectionId: "collection_alpha",
                summaryVersion: "alpha-v1",
                evidenceIds: ["decision_alpha"],
              },
              {
                collectionId: "collection_foreign",
                summaryVersion: "foreign-v1",
                evidenceIds: ["decision_foreign"],
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow("Every relationship endpoint must be a live collection in workspace_one");

    await expect(
      listCollectionRelationships(client(), {
        workspaceId: "workspace_one",
        collectionIds: ["collection_alpha", "collection_beta", "collection_gamma"],
      }),
    ).resolves.toEqual([]);
  });
});
