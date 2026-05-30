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

import { createHash } from "node:crypto";
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

// Merkle tamper-evidence (doco-vnext, optional track). Each version's
// this_hash = H(prev_hash, entity_id, version, op, payload, tx_id, actor) so
// the per-entity history forms a hash chain — rewriting any past version
// breaks every hash after it (detectable via verifyHistory). Append-only by
// policy (triggers) + cryptographically verifiable.
// Deterministic JSON: sorted keys, recursively. Hashing must survive the
// JSONB round-trip (Postgres jsonb does NOT preserve key order, and timestamps
// stored as Dates come back as strings), so canonicalize the payload the same
// way at write time and at verify time. JSON.parse(JSON.stringify(...)) first
// flattens Dates→ISO strings + drops undefined; stableStringify then sorts.
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

function canonicalPayload(payload: Record<string, unknown>): string {
  return stableStringify(JSON.parse(JSON.stringify(payload)));
}

function chainHash(
  prevHash: string | null,
  f: {
    entityId: string;
    version: number;
    op: Op;
    payload: Record<string, unknown>;
    txId: number;
    actor: string | null;
  },
): string {
  return createHash("sha256")
    .update(prevHash ?? "genesis")
    .update(
      `\n${f.entityId}\n${f.version}\n${f.op}\n${canonicalPayload(f.payload)}\n${f.txId}\n${f.actor ?? ""}`,
    )
    .digest("hex");
}

async function priorVersion(
  c: pg.PoolClient,
  table: string,
  entityId: string,
): Promise<{ nextVersion: number; prevHash: string | null }> {
  const { rows } = await c.query<{ version: number; this_hash: string | null }>(
    `SELECT version, this_hash FROM ${table} WHERE entity_id = $1 ORDER BY version DESC LIMIT 1`,
    [entityId],
  );
  if (rows.length === 0) return { nextVersion: 1, prevHash: null };
  return { nextVersion: Number(rows[0].version) + 1, prevHash: rows[0].this_hash ?? null };
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
  const { nextVersion: version, prevHash } = await priorVersion(c, "node_versions", v.entityId);
  const thisHash = chainHash(prevHash, {
    entityId: v.entityId,
    version,
    op: v.op,
    payload: v.payload,
    txId: v.txId,
    actor: v.actor ?? null,
  });
  await c.query(
    `INSERT INTO node_versions (entity_id, entity_type, version, op, payload, tx_id, actor, prev_hash, this_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      v.entityId,
      v.entityType,
      version,
      v.op,
      JSON.stringify(v.payload),
      v.txId,
      v.actor ?? null,
      prevHash,
      thisHash,
    ],
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
  const { nextVersion: version, prevHash } = await priorVersion(c, "edge_versions", v.entityId);
  const thisHash = chainHash(prevHash, {
    entityId: v.entityId,
    version,
    op: v.op,
    payload: v.payload,
    txId: v.txId,
    actor: v.actor ?? null,
  });
  await c.query(
    `INSERT INTO edge_versions (entity_id, entity_type, version, op, payload, tx_id, actor, prev_hash, this_hash)
     VALUES ($1, 'edge', $2, $3, $4, $5, $6, $7, $8)`,
    [
      v.entityId,
      version,
      v.op,
      JSON.stringify(v.payload),
      v.txId,
      v.actor ?? null,
      prevHash,
      thisHash,
    ],
  );
  return version;
}

/**
 * Record a node/entity version from the capture path. Determines op
 * (create / update / retire) from whether prior versions exist + the
 * lifecycle, opens a changeset, and appends the snapshot. Call within the
 * caller's transaction (pass its client) so the version is atomic with the
 * current-state write.
 */
export async function recordEntityVersion(
  c: pg.PoolClient,
  input: {
    docoId: string;
    entityType: string;
    entityId: string;
    payload: Record<string, unknown>;
    actor?: string | null;
    reason?: string | null;
  },
): Promise<void> {
  const { rows } = await c.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM node_versions WHERE entity_id = $1",
    [input.entityId],
  );
  const lifecycle = typeof input.payload.lifecycle === "string" ? input.payload.lifecycle : null;
  const op: Op = rows[0].n === 0 ? "create" : lifecycle === "retired" ? "retire" : "update";
  const txId = await createChangeset(c, {
    docoId: input.docoId,
    actor: input.actor ?? null,
    source: "api",
    reason: input.reason ?? null,
  });
  await appendNodeVersion(c, {
    entityId: input.entityId,
    entityType: input.entityType,
    op,
    payload: input.payload,
    txId,
    actor: input.actor ?? null,
  });
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

export interface VersionEntry {
  version: number;
  op: Op;
  tx_id: number;
  actor: string | null;
  recorded_at: string | null;
  /** The rich "why" from the commit log. */
  reason: string | null;
  payload: Record<string, unknown>;
}

/** Full version history of one node or edge, oldest first, joined to the
 *  commit log so each entry carries who / when / why. */
export async function getVersions(
  c: pg.PoolClient,
  kind: "node" | "edge",
  entityId: string,
): Promise<VersionEntry[]> {
  const table = kind === "edge" ? "edge_versions" : "node_versions";
  const { rows } = await c.query(
    `SELECT v.version, v.op, v.tx_id, v.actor, v.recorded_at, cs.reason, v.payload
       FROM ${table} v
       LEFT JOIN changesets cs ON cs.tx_id = v.tx_id
      WHERE v.entity_id = $1
      ORDER BY v.version ASC`,
    [entityId],
  );
  return rows.map((r) => ({
    version: Number(r.version),
    op: r.op as Op,
    tx_id: Number(r.tx_id),
    actor: (r.actor as string | null) ?? null,
    recorded_at: r.recorded_at ? String(r.recorded_at) : null,
    reason: (r.reason as string | null) ?? null,
    payload: r.payload as Record<string, unknown>,
  }));
}

/**
 * Verify the Merkle hash chain of one entity's history (tamper-evidence).
 * Recomputes each version's hash from the prior version + row contents; any
 * rewrite of a past version breaks the chain from that version onward.
 */
export async function verifyHistory(
  c: pg.PoolClient,
  kind: "node" | "edge",
  entityId: string,
): Promise<{ ok: boolean; versions: number; brokenAtVersion?: number }> {
  const table = kind === "edge" ? "edge_versions" : "node_versions";
  const { rows } = await c.query(
    `SELECT entity_id, version, op, payload, tx_id, actor, prev_hash, this_hash
       FROM ${table} WHERE entity_id = $1 ORDER BY version ASC`,
    [entityId],
  );
  let prev: string | null = null;
  for (const r of rows) {
    const expected = chainHash(prev, {
      entityId: String(r.entity_id),
      version: Number(r.version),
      op: r.op as Op,
      payload: r.payload as Record<string, unknown>,
      txId: Number(r.tx_id),
      actor: (r.actor as string | null) ?? null,
    });
    if (r.prev_hash !== prev || r.this_hash !== expected) {
      return { ok: false, versions: rows.length, brokenAtVersion: Number(r.version) };
    }
    prev = r.this_hash as string;
  }
  return { ok: true, versions: rows.length };
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
