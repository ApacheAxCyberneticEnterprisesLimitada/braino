import type { PoolClient } from "@doco/db";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import { applyChangeset } from "../changesets.js";
import { initializeSingleWorkspace } from "../single-workspace.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;

async function initializedCollections() {
  const initialized = await initializeSingleWorkspace(client(), {
    workspaceHandle: "acme",
    workspaceName: "Acme",
    ownerEmail: "owner@example.com",
    ownerUsername: "owner",
    ownerName: "Acme Owner",
    ownerPasswordHash: "scrypt$salt$key",
  });
  const collections = await db.query<{ id: string; handle: string }>(
    "SELECT id, handle FROM collections WHERE handle IN ('acme-product-decisions', 'acme-ideas')",
  );
  const productDecisions = collections.rows.find(
    (collection) => collection.handle === "acme-product-decisions",
  );
  const ideas = collections.rows.find((collection) => collection.handle === "acme-ideas");
  if (!productDecisions || !ideas) throw new Error("Expected both collections to be seeded.");
  return { initialized, productDecisions, ideas };
}

describe("changeset authoring", () => {
  it("creates nodes through one atomic current-state, history, and audit write", async () => {
    const { initialized, productDecisions: collection } = await initializedCollections();

    const result = await applyChangeset(client(), {
      collectionHandle: collection.handle,
      actorId: initialized.owner.id,
      source: "ui",
      reason: "Capture the launch decision",
      operations: [
        {
          op: "create",
          node_type: "decision",
          alias: "launch",
          body: {
            prose: "Launch the open core\n\nShip the independently useful product first.",
            lifecycle: "drafting",
            extra: { question: "What should ship first?", chosen: "The open core" },
          },
        },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      aliases: { launch: expect.stringMatching(/^decision_[0-9A-HJKMNP-TV-Z]{26}$/) },
      results: [
        {
          op_index: 0,
          op: "create",
          ok: true,
          alias: "launch",
          id: expect.stringMatching(/^decision_[0-9A-HJKMNP-TV-Z]{26}$/),
        },
      ],
    });
    const created = result.results[0];
    if (!created) throw new Error("Expected one create result.");
    const id = created.id;

    const node = await db.query<{
      prose: string;
      lifecycle: string;
      extra: Record<string, unknown>;
      created_by: string;
    }>("SELECT prose, lifecycle, extra, created_by FROM nodes WHERE id = $1", [id]);
    expect(node.rows[0]).toEqual({
      prose: "Launch the open core\n\nShip the independently useful product first.",
      lifecycle: "drafting",
      extra: { question: "What should ship first?", chosen: "The open core" },
      created_by: initialized.owner.id,
    });

    const history = await db.query<{
      source: string;
      reason: string;
      actor: string;
      entity_type: string;
      op: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT c.source, c.reason, c.actor, v.entity_type, v.op, v.payload
         FROM node_versions v
         JOIN changesets c ON c.tx_id = v.tx_id
        WHERE v.entity_id = $1`,
      [id],
    );
    expect(history.rows[0]).toMatchObject({
      source: "ui",
      reason: "Capture the launch decision",
      actor: initialized.owner.id,
      entity_type: "decision",
      op: "create",
      payload: {
        id,
        collection_id: collection.id,
        node_type: "decision",
        prose: "Launch the open core\n\nShip the independently useful product first.",
      },
    });

    const audit = await db.query<{
      by_user: string;
      entity_type: string;
      entity_id: string;
      op: string;
      reason: string;
    }>(
      "SELECT by_user, entity_type, entity_id, op, reason FROM audit_events WHERE entity_id = $1",
      [id],
    );
    expect(audit.rows[0]).toEqual({
      by_user: initialized.owner.id,
      entity_type: "decision",
      entity_id: id,
      op: "entity.create",
      reason: "Capture the launch decision",
    });
  });

  it("rejects an invalid batch before any operation is written", async () => {
    const { initialized, productDecisions: collection } = await initializedCollections();

    await expect(
      applyChangeset(client(), {
        collectionHandle: collection.handle,
        actorId: initialized.owner.id,
        operations: [
          { op: "create", node_type: "idea", body: { prose: "A valid first record" } },
          { op: "delete", target: "idea_01INVALID" },
        ],
      }),
    ).rejects.toMatchObject({
      code: "unsupported_operation",
      operationIndex: 1,
    });

    const counts = await db.query<{ nodes: number; changesets: number; audit_events: number }>(
      `SELECT
         (SELECT count(*)::int FROM nodes WHERE collection_id = $1) AS nodes,
         (SELECT count(*)::int FROM changesets WHERE collection_id = $1) AS changesets,
         (SELECT count(*)::int FROM audit_events WHERE collection_id = $1) AS audit_events`,
      [collection.id],
    );
    expect(counts.rows[0]).toEqual({ nodes: 0, changesets: 0, audit_events: 0 });
  });

  it("enforces the actor's per-type write grant", async () => {
    const { initialized, productDecisions: collection, ideas } = await initializedCollections();
    const readerId = "user_01J00000000000000000000000";
    await db.query(
      `INSERT INTO users (id, username, name, email, password_hash, data)
       VALUES ($1, 'reader', 'Reader', 'reader@example.com', 'hash', '{}'::jsonb)`,
      [readerId],
    );
    await db.query(
      `INSERT INTO workspace_users (workspace_id, user_id, role, write_types)
       VALUES ($1, $2, 'reader', ARRAY['idea'])`,
      [initialized.workspace.id, readerId],
    );

    await expect(
      applyChangeset(client(), {
        collectionHandle: collection.handle,
        actorId: readerId,
        operations: [{ op: "create", node_type: "decision", body: { prose: "Not permitted" } }],
      }),
    ).rejects.toMatchObject({ code: "write_forbidden", status: 403 });

    await expect(
      applyChangeset(client(), {
        collectionHandle: ideas.handle,
        actorId: readerId,
        operations: [{ op: "create", node_type: "idea", body: { prose: "Permitted" } }],
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("enforces deterministic collection authoring policies", async () => {
    const { initialized, productDecisions } = await initializedCollections();

    await expect(
      applyChangeset(client(), {
        collectionHandle: productDecisions.handle,
        actorId: initialized.owner.id,
        operations: [{ op: "create", node_type: "idea", body: { prose: "Wrong collection" } }],
      }),
    ).rejects.toMatchObject({ code: "authoring_policy_failed", status: 422 });

    const nodes = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM nodes WHERE collection_id = $1",
      [productDecisions.id],
    );
    expect(nodes.rows[0]?.count).toBe(0);
  });

  it("keeps identity and prose outside the caller-controlled extra bag", async () => {
    const { initialized, productDecisions } = await initializedCollections();

    const result = await applyChangeset(client(), {
      collectionHandle: productDecisions.handle,
      actorId: initialized.owner.id,
      operations: [
        {
          op: "create",
          node_type: "decision",
          body: {
            prose: "Canonical prose",
            extra: {
              id: "idea_01J00000000000000000000000",
              collection_id: "collection_01J00000000000000000000000",
              node_type: "idea",
              prose: "Spoofed prose",
            },
          },
        },
      ],
    });

    const created = await db.query<{
      id: string;
      collection_id: string;
      node_type: string;
      prose: string;
      extra: Record<string, unknown>;
    }>("SELECT id, collection_id, node_type, prose, extra FROM nodes WHERE id = $1", [
      result.results[0]?.id,
    ]);
    expect(created.rows[0]).toEqual({
      id: result.results[0]?.id,
      collection_id: productDecisions.id,
      node_type: "decision",
      prose: "Canonical prose",
      extra: {},
    });
  });
});
