import type { Database } from "better-sqlite3";
import type { Entity } from "@doco/shared";
import { deriveEdges } from "./edges.js";

/**
 * Insert one entity into the index. Routes to the right table based on
 * `node_type`, also re-emits edges and FTS rows.
 *
 * Designed to be called inside a transaction by the caller.
 */
export function insertEntity(db: Database, entity: Entity, body: string): void {
  const e = entity as unknown as Record<string, unknown>;
  const raw = JSON.stringify(entity);
  const id = entity.id;
  const docoId = (e.doco_id as string) ?? "";
  const summary = (e.summary as string) ?? "";
  const createdAt = (e.created_at as string) ?? "";
  const createdBy = (e.created_by as string) ?? "";
  const lifecycle = (e.lifecycle as string | null) ?? null;

  switch (entity.node_type) {
    case "doco":
      db.prepare(
        `INSERT OR REPLACE INTO doco_root (id, slug, display_name, visibility, default_branch, owner_id, description, summary, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        e.slug as string,
        e.display_name as string,
        e.visibility as string,
        (e.default_branch as string) ?? null,
        e.owner_id as string,
        (e.description as string) ?? null,
        (e.summary as string) ?? null,
        raw,
      );
      break;

    case "principal":
      db.prepare(
        `INSERT OR REPLACE INTO principal (id, doco_id, summary, type, username, display_name, owner_id, created_at, created_by, lifecycle, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        docoId,
        summary,
        e.type as string,
        e.username as string,
        e.display_name as string,
        (e.owner_id as string) ?? null,
        createdAt,
        createdBy,
        lifecycle,
        raw,
      );
      break;

    case "intent":
      db.prepare(
        `INSERT OR REPLACE INTO intent (id, doco_id, summary, title, parent_intent_id, priority, created_at, created_by, lifecycle, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        docoId,
        summary,
        e.title as string,
        (e.parent_intent_id as string | null) ?? null,
        (e.priority as string) ?? null,
        createdAt,
        createdBy,
        lifecycle,
        raw,
      );
      break;

    case "rule":
      db.prepare(
        `INSERT OR REPLACE INTO rule (id, doco_id, summary, modality, severity, phase, on_violation, predicate, created_at, created_by, lifecycle, born_from, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        docoId,
        summary,
        e.modality as string,
        (e.severity as string) ?? null,
        e.phase as string,
        (e.on_violation as string) ?? null,
        (e.predicate as string) ?? null,
        createdAt,
        createdBy,
        lifecycle,
        (e.born_from as string) ?? null,
        raw,
      );
      break;

    case "decision":
      db.prepare(
        `INSERT OR REPLACE INTO decision (id, doco_id, summary, question, chosen, decided_by, decided_at, superseded_by, created_at, created_by, lifecycle, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        docoId,
        summary,
        e.question as string,
        (e.chosen as string | null) ?? null,
        e.decided_by as string,
        e.decided_at as string,
        (e.superseded_by as string | null) ?? null,
        createdAt,
        createdBy,
        lifecycle,
        raw,
      );
      break;

    case "action":
      db.prepare(
        `INSERT OR REPLACE INTO action (id, doco_id, summary, actor_id, verb, target, started_at, ended_at, created_at, created_by, lifecycle, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        docoId,
        summary,
        e.actor_id as string,
        e.verb as string,
        (e.target as string) ?? null,
        (e.started_at as string) ?? null,
        (e.ended_at as string) ?? null,
        createdAt,
        createdBy,
        lifecycle,
        raw,
      );
      break;

    case "reasoning":
      db.prepare(
        `INSERT OR REPLACE INTO reasoning (id, doco_id, summary, author_id, conclusion_ref, confidence, created_at, created_by, lifecycle, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        docoId,
        summary,
        e.author_id as string,
        (e.conclusion_ref as string) ?? null,
        (e.confidence as number) ?? null,
        createdAt,
        createdBy,
        lifecycle,
        raw,
      );
      break;

    case "reference":
      db.prepare(
        `INSERT OR REPLACE INTO reference (id, doco_id, summary, ref_type, locator, content_hash, created_at, created_by, lifecycle, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        docoId,
        summary,
        e.ref_type as string,
        e.locator as string,
        (e.content_hash as string) ?? null,
        createdAt,
        createdBy,
        lifecycle,
        raw,
      );
      break;

    case "eval": {
      const criterion = (e.criterion as { kind?: string } | undefined) ?? { kind: "exact" };
      db.prepare(
        `INSERT OR REPLACE INTO eval (id, doco_id, summary, name, target_ref, criterion_kind, last_run_at, last_status, created_at, created_by, lifecycle, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        docoId,
        summary,
        e.name as string,
        (e.target_ref as string | undefined) ?? null,
        criterion.kind ?? "exact",
        (e.last_run_at as string | undefined) ?? null,
        (e.last_status as string | undefined) ?? null,
        createdAt,
        createdBy,
        lifecycle,
        raw,
      );
      break;
    }

    case "scope":
      db.prepare(
        `INSERT OR REPLACE INTO scope (id, doco_id, summary, name, description, created_at, created_by, lifecycle, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        docoId,
        summary,
        e.name as string,
        (e.description as string) ?? null,
        createdAt,
        createdBy,
        lifecycle,
        raw,
      );
      break;

    case "organization":
      db.prepare(
        `INSERT OR REPLACE INTO organization (id, doco_id, summary, slug, display_name, description, visibility, created_at, created_by, lifecycle, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        docoId,
        summary,
        e.slug as string,
        e.display_name as string,
        (e.description as string) ?? null,
        (e.visibility as string) ?? null,
        createdAt,
        createdBy,
        lifecycle,
        raw,
      );
      break;

    case "idea":
      db.prepare(
        `INSERT OR REPLACE INTO idea (id, doco_id, summary, body, proposer_id, promoted_to, rejection_reason, created_at, created_by, lifecycle, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        docoId,
        summary,
        (e.body as string) ?? null,
        (e.proposer_id as string) ?? null,
        (e.promoted_to as string) ?? null,
        (e.rejection_reason as string) ?? null,
        createdAt,
        createdBy,
        lifecycle,
        raw,
      );
      break;
  }

  // FTS row. For scopes, fold purpose + guidelines + description into the body
  // so FTS5 search can match on them. (ADR-082.)
  let ftsBody = body;
  if (entity.node_type === "scope") {
    const extras = [e.purpose, e.guidelines, e.description]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join("\n\n");
    ftsBody = ftsBody ? `${ftsBody}\n\n${extras}` : extras;
  }
  db.prepare(`INSERT INTO fts (id, node_type, summary, body) VALUES (?, ?, ?, ?)`).run(
    id,
    entity.node_type,
    summary,
    ftsBody,
  );

  // Edges. Each edge carries an attribution: 'explicit' if the source
  // entity declared the ref in its frontmatter (the normal case), or
  // 'doco-auto' if the LLM auto-detected the relationship (per the
  // `llm-auto-edge-detection-on-capture` ADR). deriveEdges reads it from
  // an `auto: true` marker on the ref payload if present.
  const edges = deriveEdges(entity);
  if (edges.length > 0) {
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO edges (from_id, from_node_type, to_id, to_node_type, edge_type, edge_props_json, attribution) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const edge of edges) {
      stmt.run(
        edge.from_id,
        edge.from_node_type,
        edge.to_id,
        edge.to_node_type,
        edge.edge_type,
        edge.edge_props ? JSON.stringify(edge.edge_props) : null,
        edge.attribution ?? "explicit",
      );
    }
  }
}

/** Remove all rows for one entity ID across all tables (for incremental updates / deletes). */
export function deleteEntity(db: Database, id: string): void {
  for (const table of [
    "doco_root",
    "principal",
    "organization",
    "intent",
    "idea",
    "rule",
    "decision",
    "action",
    "reasoning",
    "eval",
    "reference",
    "scope",
  ]) {
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  }
  db.prepare(`DELETE FROM fts WHERE id = ?`).run(id);
  db.prepare(`DELETE FROM edges WHERE from_id = ? OR to_id = ?`).run(id, id);
  db.prepare(`DELETE FROM scope_match WHERE source_id = ? OR target_id = ?`).run(id, id);
}
