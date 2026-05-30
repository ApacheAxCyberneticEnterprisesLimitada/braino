// Append-only write runtime (doco-vnext).
//
// The single write boundary for the new model. Every mutation:
//   1. opens a changeset (the commit — who/when/WHY, a monotonic tx_id),
//   2. appends an immutable version snapshot per touched node/edge,
//   3. updates the current-state projection (per-type node tables / edges).
//
// Nothing is ever deleted: removal is an `op='retire'` version +
// lifecycle='retired'. Edges are first-class — their own id, lifecycle,
// provenance, and history, mutated ONLY here (never wiped by the indexer).
//
// See docs/plans/doco-vnext.md.

import { type EntityId, generateUlid, makeEntityId } from "@doco/shared";
import type pg from "pg";

export type CommitSource = "api" | "mcp" | "ui" | "slack" | "import" | "reset" | "system";

export interface CommitInput {
  docoId: string;
  actor?: string | null;
  source?: CommitSource;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Open a commit (changeset) and return its monotonic tx_id. */
export async function createChangeset(c: pg.PoolClient, input: CommitInput): Promise<number> {
  const { rows } = await c.query<{ tx_id: string }>(
    `INSERT INTO changesets (doco_id, actor, source, reason, metadata)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING tx_id`,
    [
      input.docoId,
      input.actor ?? null,
      input.source ?? "api",
      input.reason ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
  return Number(rows[0].tx_id);
}

type Op = "create" | "update" | "retire";

async function nextVersion(c: pg.PoolClient, table: string, entityId: string): Promise<number> {
  const { rows } = await c.query<{ v: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM ${table} WHERE entity_id = $1`,
    [entityId],
  );
  return Number(rows[0].v);
}

/** Append an immutable snapshot of a node to node_versions. */
export async function appendNodeVersion(
  c: pg.PoolClient,
  v: {
    entityId: string;
    entityType: string;
    op: Op;
    payload: Record<string, unknown>;
    txId: number;
    actor?: string | null;
  },
): Promise<number> {
  const version = await nextVersion(c, "node_versions", v.entityId);
  await c.query(
    `INSERT INTO node_versions (entity_id, entity_type, version, op, payload, tx_id, actor)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [v.entityId, v.entityType, version, v.op, JSON.stringify(v.payload), v.txId, v.actor ?? null],
  );
  return version;
}

/** Append an immutable snapshot of an edge to edge_versions. */
export async function appendEdgeVersion(
  c: pg.PoolClient,
  v: {
    entityId: string;
    op: Op;
    payload: Record<string, unknown>;
    txId: number;
    actor?: string | null;
  },
): Promise<number> {
  const version = await nextVersion(c, "edge_versions", v.entityId);
  await c.query(
    `INSERT INTO edge_versions (entity_id, entity_type, version, op, payload, tx_id, actor)
     VALUES ($1, 'edge', $2, $3, $4, $5, $6)`,
    [v.entityId, version, v.op, JSON.stringify(v.payload), v.txId, v.actor ?? null],
  );
  return version;
}

export interface CreateEdgeInput {
  docoId: string;
  edgeType: string;
  fromId: string;
  fromNodeType: string;
  toId: string;
  toNodeType: string;
  props?: Record<string, unknown> | null;
  lifecycle?: "drafting" | "asserted";
  actor?: string | null;
}

export interface EdgeRow {
  id: EntityId<"edge">;
  doco_id: string;
  edge_type: string;
  from_id: string;
  from_node_type: string;
  to_id: string;
  to_node_type: string;
  props: Record<string, unknown> | null;
  lifecycle: string;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
  retired_at: string | null;
}

/** Create a first-class edge + its v1 snapshot, within an open commit. */
export async function createEdge(
  c: pg.PoolClient,
  txId: number,
  input: CreateEdgeInput,
): Promise<EdgeRow> {
  const id = makeEntityId("edge", generateUlid());
  const { rows } = await c.query<EdgeRow>(
    `INSERT INTO edges
       (id, doco_id, edge_type, from_id, from_node_type, to_id, to_node_type,
        props, lifecycle, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
     RETURNING *`,
    [
      id,
      input.docoId,
      input.edgeType,
      input.fromId,
      input.fromNodeType,
      input.toId,
      input.toNodeType,
      input.props ? JSON.stringify(input.props) : null,
      input.lifecycle ?? "asserted",
      input.actor ?? null,
    ],
  );
  const row = rows[0];
  await appendEdgeVersion(c, {
    entityId: id,
    op: "create",
    payload: row as unknown as Record<string, unknown>,
    txId,
    actor: input.actor ?? null,
  });
  return row;
}

/** Mutate an edge's props and/or lifecycle (endpoints are immutable). */
export async function updateEdge(
  c: pg.PoolClient,
  txId: number,
  input: {
    id: string;
    props?: Record<string, unknown> | null;
    lifecycle?: "drafting" | "asserted";
    actor?: string | null;
  },
): Promise<EdgeRow> {
  const { rows } = await c.query<EdgeRow>(
    `UPDATE edges
        SET props      = COALESCE($2, props),
            lifecycle  = COALESCE($3, lifecycle),
            updated_at = now(),
            updated_by = $4
      WHERE id = $1
      RETURNING *`,
    [
      input.id,
      input.props === undefined ? null : JSON.stringify(input.props),
      input.lifecycle ?? null,
      input.actor ?? null,
    ],
  );
  if (rows.length === 0) throw new Error(`edge not found: ${input.id}`);
  const row = rows[0];
  await appendEdgeVersion(c, {
    entityId: input.id,
    op: "update",
    payload: row as unknown as Record<string, unknown>,
    txId,
    actor: input.actor ?? null,
  });
  return row;
}

/** Retire an edge (the only "delete"). Frees the live-unique slot. */
export async function retireEdge(
  c: pg.PoolClient,
  txId: number,
  input: { id: string; actor?: string | null },
): Promise<EdgeRow> {
  const { rows } = await c.query<EdgeRow>(
    `UPDATE edges
        SET lifecycle = 'retired', retired_at = now(), updated_at = now(), updated_by = $2
      WHERE id = $1
      RETURNING *`,
    [input.id, input.actor ?? null],
  );
  if (rows.length === 0) throw new Error(`edge not found: ${input.id}`);
  const row = rows[0];
  await appendEdgeVersion(c, {
    entityId: input.id,
    op: "retire",
    payload: row as unknown as Record<string, unknown>,
    txId,
    actor: input.actor ?? null,
  });
  return row;
}

/** Full version history of one node or edge, oldest first. */
export async function getVersions(
  c: pg.PoolClient,
  kind: "node" | "edge",
  entityId: string,
): Promise<Array<{ version: number; op: Op; tx_id: number; payload: Record<string, unknown> }>> {
  const table = kind === "edge" ? "edge_versions" : "node_versions";
  const { rows } = await c.query(
    `SELECT version, op, tx_id, payload FROM ${table} WHERE entity_id = $1 ORDER BY version ASC`,
    [entityId],
  );
  return rows.map((r) => ({
    version: Number(r.version),
    op: r.op as Op,
    tx_id: Number(r.tx_id),
    payload: r.payload as Record<string, unknown>,
  }));
}

/**
 * Reconstruct a node/edge AS OF a transaction id — the snapshot of the
 * latest version recorded at or before `txId`. O(1) read, never a replay.
 */
export async function entityAsOf(
  c: pg.PoolClient,
  kind: "node" | "edge",
  entityId: string,
  txId: number,
): Promise<{ version: number; op: Op; payload: Record<string, unknown> } | null> {
  const table = kind === "edge" ? "edge_versions" : "node_versions";
  const { rows } = await c.query(
    `SELECT version, op, payload FROM ${table}
      WHERE entity_id = $1 AND tx_id <= $2
      ORDER BY version DESC LIMIT 1`,
    [entityId, txId],
  );
  if (rows.length === 0) return null;
  return {
    version: Number(rows[0].version),
    op: rows[0].op as Op,
    payload: rows[0].payload as Record<string, unknown>,
  };
}
