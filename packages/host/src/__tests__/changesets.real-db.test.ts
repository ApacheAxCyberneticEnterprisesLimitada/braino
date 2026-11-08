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

  it("creates first-class edges between aliases in the same atomic changeset", async () => {
    const { initialized, productDecisions } = await initializedCollections();

    const result = await applyChangeset(client(), {
      collectionHandle: productDecisions.handle,
      actorId: initialized.owner.id,
      reason: "Connect the related decisions",
      operations: [
        {
          op: "create",
          node_type: "decision",
          alias: "first",
          body: { prose: "First decision" },
        },
        {
          op: "create",
          node_type: "decision",
          alias: "second",
          body: { prose: "Second decision" },
        },
        {
          op: "relate",
          relation_kind: "relates_to",
          from: "$first",
          to: "$second",
        },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      aliases: {
        first: expect.stringMatching(/^decision_/),
        second: expect.stringMatching(/^decision_/),
      },
      results: [
        { op_index: 0, op: "create", ok: true },
        { op_index: 1, op: "create", ok: true },
        {
          op_index: 2,
          op: "relate",
          ok: true,
          relation: {
            kind: "relates_to",
            from: expect.stringMatching(/^decision_/),
            to: expect.stringMatching(/^decision_/),
            edge_id: expect.stringMatching(/^edge_/),
          },
        },
      ],
    });

    const edge = await db.query<{
      id: string;
      edge_type: string;
      from_id: string;
      to_id: string;
      lifecycle: string;
      origin: string;
    }>("SELECT id, edge_type, from_id, to_id, lifecycle, origin FROM edges");
    expect(edge.rows[0]).toEqual({
      id: result.results[2]?.relation?.edge_id,
      edge_type: "relates_to",
      from_id: result.aliases.first,
      to_id: result.aliases.second,
      lifecycle: "drafting",
      origin: "authored",
    });

    const history = await db.query<{ tx_ids: number; edge_versions: number; audit_events: number }>(
      `SELECT
         (SELECT count(DISTINCT tx_id)::int FROM (
            SELECT tx_id FROM node_versions
            UNION ALL
            SELECT tx_id FROM edge_versions
          ) versions) AS tx_ids,
         (SELECT count(*)::int FROM edge_versions) AS edge_versions,
         (SELECT count(*)::int FROM audit_events WHERE collection_id = $1) AS audit_events`,
      [productDecisions.id],
    );
    expect(history.rows[0]).toEqual({ tx_ids: 1, edge_versions: 1, audit_events: 3 });
  });

  it("rolls back relate_many when one relation violates the collection edge policy", async () => {
    const { initialized, productDecisions } = await initializedCollections();

    await expect(
      applyChangeset(client(), {
        collectionHandle: productDecisions.handle,
        actorId: initialized.owner.id,
        operations: [
          {
            op: "create",
            node_type: "decision",
            alias: "first",
            body: { prose: "First decision" },
          },
          {
            op: "create",
            node_type: "decision",
            alias: "second",
            body: { prose: "Second decision" },
          },
          {
            op: "relate_many",
            relations: [
              { relation_kind: "relates_to", from: "$first", to: "$second" },
              { relation_kind: "flows_to", from: "$first", to: "$second" },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "authoring_policy_failed", status: 422, operationIndex: 2 });

    const counts = await db.query<{ nodes: number; edges: number; changesets: number }>(
      `SELECT
         (SELECT count(*)::int FROM nodes WHERE collection_id = $1) AS nodes,
         (SELECT count(*)::int FROM edges WHERE collection_id = $1) AS edges,
         (SELECT count(*)::int FROM changesets WHERE collection_id = $1) AS changesets`,
      [productDecisions.id],
    );
    expect(counts.rows[0]).toEqual({ nodes: 0, edges: 0, changesets: 0 });
  });

  it("rejects an active edge when either endpoint is still drafting", async () => {
    const { initialized, productDecisions } = await initializedCollections();

    await expect(
      applyChangeset(client(), {
        collectionHandle: productDecisions.handle,
        actorId: initialized.owner.id,
        operations: [
          {
            op: "create",
            node_type: "decision",
            alias: "first",
            body: { prose: "First decision" },
          },
          {
            op: "create",
            node_type: "decision",
            alias: "second",
            body: { prose: "Second decision" },
          },
          {
            op: "relate",
            relation_kind: "relates_to",
            from: "$first",
            to: "$second",
            lifecycle: "active",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "edge_endpoints_not_active", status: 422 });

    const edges = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM edges");
    expect(edges.rows[0]?.count).toBe(0);
  });

  it("requires an edge-specific write grant", async () => {
    const { initialized, productDecisions } = await initializedCollections();
    const readerId = "user_01J00000000000000000000001";
    await db.query(
      `INSERT INTO users (id, username, name, email, password_hash, data)
       VALUES ($1, 'decision-writer', 'Decision Writer', 'writer@example.com', 'hash', '{}'::jsonb)`,
      [readerId],
    );
    await db.query(
      `INSERT INTO workspace_users (workspace_id, user_id, role, write_types)
       VALUES ($1, $2, 'reader', ARRAY['decision'])`,
      [initialized.workspace.id, readerId],
    );

    await expect(
      applyChangeset(client(), {
        collectionHandle: productDecisions.handle,
        actorId: readerId,
        operations: [
          { op: "create", node_type: "decision", alias: "first", body: { prose: "First" } },
          { op: "create", node_type: "decision", alias: "second", body: { prose: "Second" } },
          { op: "relate", relation_kind: "relates_to", from: "$first", to: "$second" },
        ],
      }),
    ).rejects.toMatchObject({ code: "write_forbidden", status: 403, operationIndex: 2 });

    const nodes = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM nodes WHERE collection_id = $1",
      [productDecisions.id],
    );
    expect(nodes.rows[0]?.count).toBe(0);
  });

  it("does not relate a collection node to an endpoint from another collection", async () => {
    const { initialized, productDecisions, ideas } = await initializedCollections();
    const external = await applyChangeset(client(), {
      collectionHandle: ideas.handle,
      actorId: initialized.owner.id,
      operations: [{ op: "create", node_type: "idea", body: { prose: "External idea" } }],
    });

    await expect(
      applyChangeset(client(), {
        collectionHandle: productDecisions.handle,
        actorId: initialized.owner.id,
        operations: [
          {
            op: "create",
            node_type: "decision",
            alias: "local",
            body: { prose: "Local decision" },
          },
          {
            op: "relate",
            relation_kind: "relates_to",
            from: "$local",
            to: external.results[0]?.id,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "relation_endpoint_not_found", status: 404 });

    const localNodes = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM nodes WHERE collection_id = $1",
      [productDecisions.id],
    );
    expect(localNodes.rows[0]?.count).toBe(0);
  });

  it("activates a node after earlier operations satisfy its committed-stage policies", async () => {
    const { initialized, productDecisions } = await initializedCollections();
    const deciderId = "principal_01J00000000000000000000000";
    await db.query(
      `INSERT INTO nodes
         (id, collection_id, node_type, lifecycle, prose, extra, created_by, updated_by)
       VALUES ($1, $2, 'principal', 'active', 'The accountable decider', '{}'::jsonb, $3, $3)`,
      [deciderId, productDecisions.id, initialized.owner.id],
    );

    const result = await applyChangeset(client(), {
      collectionHandle: productDecisions.handle,
      actorId: initialized.owner.id,
      operations: [
        {
          op: "create",
          node_type: "decision",
          alias: "launch",
          body: {
            prose: "Launch the public core",
            lifecycle: "drafting",
            extra: { chosen: "Ship the independently useful product" },
          },
        },
        {
          op: "relate",
          relation_kind: "attributed_to",
          from: "$launch",
          to: deciderId,
        },
        { op: "activate", target: "$launch" },
      ],
    });

    expect(result.results[2]).toMatchObject({
      op_index: 2,
      op: "activate",
      ok: true,
      id: result.aliases.launch,
    });
    const activated = await db.query<{ lifecycle: string }>(
      "SELECT lifecycle FROM nodes WHERE id = $1",
      [result.aliases.launch],
    );
    expect(activated.rows[0]?.lifecycle).toBe("active");
  });

  it("keeps demotion graph-safe and cascades active edges in the same commit when requested", async () => {
    const { initialized, productDecisions } = await initializedCollections();
    await db.query("UPDATE policies SET lifecycle = 'retired' WHERE collection_id = $1", [
      productDecisions.id,
    ]);
    const created = await applyChangeset(client(), {
      collectionHandle: productDecisions.handle,
      actorId: initialized.owner.id,
      operations: [
        {
          op: "create",
          node_type: "decision",
          alias: "first",
          body: { prose: "First", lifecycle: "active" },
        },
        {
          op: "create",
          node_type: "decision",
          alias: "second",
          body: { prose: "Second", lifecycle: "active" },
        },
        {
          op: "relate",
          relation_kind: "relates_to",
          from: "$first",
          to: "$second",
          lifecycle: "active",
        },
      ],
    });
    const edgeId = created.results[2]?.relation?.edge_id;

    await expect(
      applyChangeset(client(), {
        collectionHandle: productDecisions.handle,
        actorId: initialized.owner.id,
        operations: [{ op: "retire", target: created.aliases.first }],
      }),
    ).rejects.toMatchObject({
      code: "active_edges_require_cascade",
      status: 422,
      operationIndex: 0,
    });

    const result = await applyChangeset(client(), {
      collectionHandle: productDecisions.handle,
      actorId: initialized.owner.id,
      reason: "Withdraw the first decision",
      operations: [
        {
          op: "retire",
          target: created.aliases.first,
          retire_active_edges: true,
        },
      ],
    });
    expect(result.results[0]).toMatchObject({
      op_index: 0,
      op: "retire",
      ok: true,
      id: created.aliases.first,
      retired_edges: [edgeId],
    });

    const current = await db.query<{ node_lifecycle: string; edge_lifecycle: string }>(
      `SELECT n.lifecycle AS node_lifecycle, e.lifecycle AS edge_lifecycle
         FROM nodes n JOIN edges e ON e.id = $2
        WHERE n.id = $1`,
      [created.aliases.first, edgeId],
    );
    expect(current.rows[0]).toEqual({ node_lifecycle: "retired", edge_lifecycle: "retired" });

    const versionCommit = await db.query<{ tx_ids: number }>(
      `SELECT count(DISTINCT tx_id)::int AS tx_ids
         FROM (
           SELECT tx_id FROM node_versions WHERE entity_id = $1 AND version = 2
           UNION ALL
           SELECT tx_id FROM edge_versions WHERE entity_id = $2 AND version = 2
         ) versions`,
      [created.aliases.first, edgeId],
    );
    expect(versionCommit.rows[0]?.tx_ids).toBe(1);
    const audit = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit_events
        WHERE op = 'lifecycle.transition' AND entity_id = ANY($1::text[])`,
      [[created.aliases.first, edgeId]],
    );
    expect(audit.rows[0]?.count).toBe(2);
  });

  it("requires write access to every edge type retired by a lifecycle cascade", async () => {
    const { initialized, productDecisions } = await initializedCollections();
    await db.query("UPDATE policies SET lifecycle = 'retired' WHERE collection_id = $1", [
      productDecisions.id,
    ]);
    const created = await applyChangeset(client(), {
      collectionHandle: productDecisions.handle,
      actorId: initialized.owner.id,
      operations: [
        {
          op: "create",
          node_type: "decision",
          alias: "first",
          body: { prose: "First", lifecycle: "active" },
        },
        {
          op: "create",
          node_type: "decision",
          alias: "second",
          body: { prose: "Second", lifecycle: "active" },
        },
        {
          op: "relate",
          relation_kind: "relates_to",
          from: "$first",
          to: "$second",
          lifecycle: "active",
        },
      ],
    });
    const decisionWriter = "user_01J00000000000000000000002";
    await db.query(
      `INSERT INTO users (id, username, name, email, password_hash, data)
       VALUES ($1, 'lifecycle-writer', 'Lifecycle Writer', 'lifecycle@example.com', 'hash', '{}'::jsonb)`,
      [decisionWriter],
    );
    await db.query(
      `INSERT INTO workspace_users (workspace_id, user_id, role, write_types)
       VALUES ($1, $2, 'reader', ARRAY['decision'])`,
      [initialized.workspace.id, decisionWriter],
    );

    await expect(
      applyChangeset(client(), {
        collectionHandle: productDecisions.handle,
        actorId: decisionWriter,
        operations: [{ op: "retire", target: created.aliases.first, retire_active_edges: true }],
      }),
    ).rejects.toMatchObject({ code: "write_forbidden", status: 403, operationIndex: 0 });

    const unchanged = await db.query<{ node_lifecycle: string; edge_lifecycle: string }>(
      `SELECT n.lifecycle AS node_lifecycle, e.lifecycle AS edge_lifecycle
         FROM nodes n JOIN edges e ON e.id = $2
        WHERE n.id = $1`,
      [created.aliases.first, created.results[2]?.relation?.edge_id],
    );
    expect(unchanged.rows[0]).toEqual({ node_lifecycle: "active", edge_lifecycle: "active" });
  });

  it("treats an already-satisfied lifecycle transition as a successful no-op", async () => {
    const { initialized, productDecisions } = await initializedCollections();
    await db.query("UPDATE policies SET lifecycle = 'retired' WHERE collection_id = $1", [
      productDecisions.id,
    ]);
    const created = await applyChangeset(client(), {
      collectionHandle: productDecisions.handle,
      actorId: initialized.owner.id,
      operations: [
        {
          op: "create",
          node_type: "decision",
          body: { prose: "Already queued", lifecycle: "queued" },
        },
      ],
    });
    const id = created.results[0]?.id;

    const result = await applyChangeset(client(), {
      collectionHandle: productDecisions.handle,
      actorId: initialized.owner.id,
      operations: [{ op: "queue", target: id }],
    });

    expect(result.results[0]).toMatchObject({ op: "queue", ok: true, id, skipped: true });
    const versions = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM node_versions WHERE entity_id = $1",
      [id],
    );
    expect(versions.rows[0]?.count).toBe(1);
  });

  it("supersedes a node with one replacement, retirement, and replaces edge commit", async () => {
    const { initialized, productDecisions } = await initializedCollections();
    const original = await applyChangeset(client(), {
      collectionHandle: productDecisions.handle,
      actorId: initialized.owner.id,
      operations: [
        {
          op: "create",
          node_type: "decision",
          body: { prose: "Use the hosted-only architecture", lifecycle: "drafting" },
        },
      ],
    });
    const oldId = original.results[0]?.id;

    const result = await applyChangeset(client(), {
      collectionHandle: productDecisions.handle,
      actorId: initialized.owner.id,
      reason: "Move to the public core",
      operations: [
        {
          op: "supersede",
          target: oldId,
          node_type: "decision",
          alias: "public_core",
          body: { prose: "Use the public core architecture", lifecycle: "drafting" },
        },
      ],
    });

    expect(result.results[0]).toMatchObject({
      op_index: 0,
      op: "supersede",
      ok: true,
      id: result.aliases.public_core,
      alias: "public_core",
      relation: {
        kind: "replaces",
        from: result.aliases.public_core,
        to: oldId,
        edge_id: expect.stringMatching(/^edge_/),
      },
    });
    const relationId = result.results[0]?.relation?.edge_id;
    const current = await db.query<{
      old_lifecycle: string;
      new_lifecycle: string;
      edge_lifecycle: string;
    }>(
      `SELECT old.lifecycle AS old_lifecycle, replacement.lifecycle AS new_lifecycle,
              edge.lifecycle AS edge_lifecycle
         FROM nodes old
         JOIN nodes replacement ON replacement.id = $2
         JOIN edges edge ON edge.id = $3
        WHERE old.id = $1`,
      [oldId, result.aliases.public_core, relationId],
    );
    expect(current.rows[0]).toEqual({
      old_lifecycle: "retired",
      new_lifecycle: "drafting",
      edge_lifecycle: "drafting",
    });

    const versionCommit = await db.query<{ tx_ids: number }>(
      `SELECT count(DISTINCT tx_id)::int AS tx_ids
         FROM (
           SELECT tx_id FROM node_versions WHERE entity_id = $1 AND version = 2
           UNION ALL
           SELECT tx_id FROM node_versions WHERE entity_id = $2
           UNION ALL
           SELECT tx_id FROM edge_versions WHERE entity_id = $3
         ) versions`,
      [oldId, result.aliases.public_core, relationId],
    );
    expect(versionCommit.rows[0]?.tx_ids).toBe(1);
  });
});
