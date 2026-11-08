import type { PoolClient } from "@doco/db";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import {
  createIncomingWebhook,
  deliverIncomingWebhook,
  revokeIncomingWebhook,
} from "../incoming-webhooks.js";
import { initializeSingleWorkspace } from "../single-workspace.js";

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
  const collection = await db.query<{ id: string; handle: string }>(
    "SELECT id, handle FROM collections WHERE handle = 'acme-glossary'",
  );
  return { setup, collection: collection.rows[0] as { id: string; handle: string } };
}

describe("generic incoming webhooks", () => {
  it("applies one policy-checked changeset and replays duplicate delivery keys", async () => {
    const { setup, collection } = await fixture();
    const webhook = await createIncomingWebhook(client(), {
      workspaceId: setup.workspace.id,
      collectionId: collection.id,
      userId: setup.owner.id,
      label: "CI release hook",
    });
    const input = {
      accessToken: webhook.accessToken,
      idempotencyKey: "release-42",
      operations: [
        {
          op: "create",
          node_type: "reference",
          body: { lifecycle: "drafting", prose: "Release 42 deployment evidence" },
        },
      ],
      reason: "Release pipeline delivered its evidence",
    };

    const first = await deliverIncomingWebhook(client(), input);
    const replay = await deliverIncomingWebhook(client(), input);

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    const counts = await db.query<{ nodes: number; changesets: number }>(
      `SELECT
         (SELECT count(*)::int FROM nodes WHERE collection_id = $1) AS nodes,
         (SELECT count(*)::int FROM changesets WHERE collection_id = $1) AS changesets`,
      [collection.id],
    );
    expect(counts.rows[0]).toEqual({ nodes: 1, changesets: 1 });
  });

  it("requires an active creator membership and stops immediately on revocation", async () => {
    const { setup, collection } = await fixture();
    const webhook = await createIncomingWebhook(client(), {
      workspaceId: setup.workspace.id,
      collectionId: collection.id,
      userId: setup.owner.id,
      label: "Build hook",
    });

    await revokeIncomingWebhook(client(), {
      tokenId: webhook.tokenId,
      userId: setup.owner.id,
    });
    await expect(
      deliverIncomingWebhook(client(), {
        accessToken: webhook.accessToken,
        idempotencyKey: "after-revoke",
        operations: [],
      }),
    ).rejects.toMatchObject({ code: "webhook_unauthorized", status: 401 });
  });
});
