/**
 * Append-only history primitives shared across the DB, host, and web
 * layers.
 *
 * Doco's source of truth is the commit log + immutable version snapshots;
 * the per-type node tables and the `edges` table are a rebuildable
 * projection (the "current state"). Nothing is ever deleted — removal is a
 * `retire` version. See docs/plans/doco-vnext.md.
 *
 * Git's object model, one-to-one:
 *   Commit      = git commit   (who / when / WHY, atomic changeset)
 *   VersionRow  = git blob/tree (full snapshot of a node/edge at vN)
 *   projection  = git working tree (fast current-state reads)
 */

import type { EntityId } from "./branded.js";

/** The kind of change a version row records. "retire" replaces deletion. */
export type EntityOp = "create" | "update" | "retire";

/** Where a write originated — recorded on every commit, aids the "why". */
export type CommitSource = "api" | "mcp" | "ui" | "slack" | "import" | "reset" | "system";

/**
 * A commit — one atomic changeset (Git's commit). Carries who/when/why.
 * `tx_id` is a global monotonic sequence used for whole-graph as-of reads.
 */
export interface Commit {
  tx_id: number;
  doco_id: EntityId<"doco">;
  actor: EntityId<"user"> | null;
  source: CommitSource;
  /** The rich "why" — supplied by the writer (agent / UI / API). */
  reason: string | null;
  metadata?: Record<string, unknown> | null;
  recorded_at: string; // ISO 8601 UTC
}

/**
 * An immutable version snapshot of one node or edge (Git's blob/tree).
 * `payload` is the FULL state of the entity at this version, so reading
 * "how it was" is an O(1) lookup — never a replay.
 */
export interface VersionRow {
  entity_id: EntityId;
  /** Node type (decision, intent, …) or "edge". */
  entity_type: string;
  version: number;
  op: EntityOp;
  payload: Record<string, unknown>;
  tx_id: number;
  actor: EntityId<"user"> | null;
  recorded_at: string;
  /** Reserved for the optional Merkle tamper-evidence track (Track M). */
  prev_hash?: string | null;
  this_hash?: string | null;
}
