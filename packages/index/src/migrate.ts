import type { Database } from "better-sqlite3";

export const INDEX_SCHEMA_VERSION = 1;

/**
 * SQLite + FTS5 index schema. Mirrors SCHEMA.md §8.2.
 *
 * Each entity kind has a per-type table with the most-queried fields as columns
 * and the full entity in `raw_json` for nested-field access. Cross-cutting
 * tables: `edges` (adjacency), `fts` (full-text on summary+body), `scope_match`
 * (denormalized Rule.applies_to → matched targets), `meta` (cache version).
 */
const MIGRATION_V1 = /* sql */ `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = OFF;

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

INSERT INTO meta (key, value) VALUES ('schema_version', '1');

CREATE TABLE evalo_root (
  id              TEXT PRIMARY KEY,
  schema_version  TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  visibility      TEXT NOT NULL,
  default_branch  TEXT,
  owner_id        TEXT NOT NULL,
  description     TEXT,
  summary         TEXT,
  raw_json        TEXT NOT NULL
);

CREATE TABLE principal (
  id              TEXT PRIMARY KEY,
  evalo_id        TEXT NOT NULL,
  schema_version  TEXT NOT NULL,
  summary         TEXT NOT NULL,
  type            TEXT NOT NULL,
  username        TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  owner_id        TEXT,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  lifecycle       TEXT,
  status          TEXT,
  raw_json        TEXT NOT NULL
);

CREATE TABLE intent (
  id                TEXT PRIMARY KEY,
  evalo_id          TEXT NOT NULL,
  schema_version    TEXT NOT NULL,
  summary           TEXT NOT NULL,
  slug              TEXT,
  title             TEXT NOT NULL,
  parent_intent_id  TEXT,
  priority          TEXT,
  created_at        TEXT NOT NULL,
  created_by        TEXT NOT NULL,
  lifecycle         TEXT,
  status            TEXT,
  raw_json          TEXT NOT NULL
);

CREATE TABLE rule (
  id              TEXT PRIMARY KEY,
  evalo_id        TEXT NOT NULL,
  schema_version  TEXT NOT NULL,
  summary         TEXT NOT NULL,
  slug            TEXT,
  modality        TEXT NOT NULL,
  severity        TEXT,
  phase           TEXT NOT NULL,
  on_violation    TEXT,
  predicate       TEXT,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  lifecycle       TEXT,
  status          TEXT,
  born_from       TEXT,
  raw_json        TEXT NOT NULL
);

CREATE TABLE decision (
  id              TEXT PRIMARY KEY,
  evalo_id        TEXT NOT NULL,
  schema_version  TEXT NOT NULL,
  summary         TEXT NOT NULL,
  slug            TEXT,
  number          TEXT,
  question        TEXT NOT NULL,
  chosen          TEXT,
  decided_by      TEXT NOT NULL,
  decided_at      TEXT NOT NULL,
  superseded_by   TEXT,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  lifecycle       TEXT,
  status          TEXT,
  raw_json        TEXT NOT NULL
);

CREATE TABLE action (
  id              TEXT PRIMARY KEY,
  evalo_id        TEXT NOT NULL,
  schema_version  TEXT NOT NULL,
  summary         TEXT NOT NULL,
  actor_id        TEXT NOT NULL,
  verb            TEXT NOT NULL,
  target          TEXT,
  started_at      TEXT,
  ended_at        TEXT,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  lifecycle       TEXT,
  status          TEXT,
  raw_json        TEXT NOT NULL
);

CREATE TABLE reasoning (
  id              TEXT PRIMARY KEY,
  evalo_id        TEXT NOT NULL,
  schema_version  TEXT NOT NULL,
  summary         TEXT NOT NULL,
  author_id       TEXT NOT NULL,
  conclusion_ref  TEXT,
  confidence      REAL,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  lifecycle       TEXT,
  status          TEXT,
  raw_json        TEXT NOT NULL
);

CREATE TABLE evaluation (
  id              TEXT PRIMARY KEY,
  evalo_id        TEXT NOT NULL,
  schema_version  TEXT NOT NULL,
  summary         TEXT NOT NULL,
  rule_id         TEXT NOT NULL,
  target_id       TEXT,
  result          TEXT NOT NULL,
  ran_at          TEXT NOT NULL,
  ran_by          TEXT NOT NULL,
  duration_ms     INTEGER,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  raw_json        TEXT NOT NULL
);

CREATE TABLE reference (
  id              TEXT PRIMARY KEY,
  evalo_id        TEXT NOT NULL,
  schema_version  TEXT NOT NULL,
  summary         TEXT NOT NULL,
  ref_type        TEXT NOT NULL,
  locator         TEXT NOT NULL,
  content_hash    TEXT,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  lifecycle       TEXT,
  status          TEXT,
  raw_json        TEXT NOT NULL
);

CREATE TABLE tag (
  id              TEXT PRIMARY KEY,
  evalo_id        TEXT NOT NULL,
  schema_version  TEXT NOT NULL,
  summary         TEXT NOT NULL,
  name            TEXT NOT NULL UNIQUE,
  description     TEXT,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  raw_json        TEXT NOT NULL
);

CREATE TABLE organization (
  id              TEXT PRIMARY KEY,
  evalo_id        TEXT NOT NULL,
  schema_version  TEXT NOT NULL,
  summary         TEXT NOT NULL,
  slug            TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  description     TEXT,
  visibility      TEXT,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  lifecycle       TEXT,
  status          TEXT,
  raw_json        TEXT NOT NULL
);
CREATE INDEX organization_slug_idx ON organization(slug);

-- Indexes for common queries
CREATE INDEX intent_lifecycle_idx ON intent(lifecycle);
CREATE INDEX rule_phase_idx ON rule(phase, modality);
CREATE INDEX decision_lifecycle_idx ON decision(lifecycle);
CREATE INDEX decision_decided_at_idx ON decision(decided_at);
CREATE INDEX action_actor_idx ON action(actor_id);
CREATE INDEX action_verb_idx ON action(verb);
CREATE INDEX evaluation_rule_idx ON evaluation(rule_id, ran_at);

-- Cross-cutting: edges derived from ID-shaped fields (D-017 fields-as-edges).
CREATE TABLE edges (
  from_id         TEXT NOT NULL,
  from_node_type  TEXT NOT NULL,
  to_id           TEXT NOT NULL,
  to_node_type    TEXT NOT NULL,
  edge_type       TEXT NOT NULL,
  edge_props_json TEXT,
  PRIMARY KEY (from_id, to_id, edge_type)
);
CREATE INDEX edges_to_idx ON edges(to_id, edge_type);
CREATE INDEX edges_from_type_idx ON edges(from_id, edge_type);
CREATE INDEX edges_type_idx ON edges(edge_type);

-- Cross-cutting: full-text search over summary + body of every entity.
CREATE VIRTUAL TABLE fts USING fts5(
  id UNINDEXED,
  node_type UNINDEXED,
  summary,
  body,
  tokenize = 'unicode61'
);

-- Cross-cutting: denormalized Rule.applies_to → matched targets (D-026).
-- Populated by the runtime check engine in phase 3.
CREATE TABLE scope_match (
  source_id         TEXT NOT NULL,
  source_node_type  TEXT NOT NULL,
  target_id         TEXT NOT NULL,
  target_node_type  TEXT NOT NULL,
  selector_rev      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (source_id, target_id)
);
CREATE INDEX scope_match_target_idx ON scope_match(target_id);
`;

export function migrate(db: Database): void {
  const currentVersion = getVersion(db);
  if (currentVersion >= INDEX_SCHEMA_VERSION) return;
  if (currentVersion === 0) {
    db.exec(MIGRATION_V1);
    return;
  }
  // Future: incremental migrations here.
  throw new Error(
    `Cannot upgrade index schema from version ${currentVersion} to ${INDEX_SCHEMA_VERSION}: no migration path defined.`,
  );
}

function getVersion(db: Database): number {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    return row ? Number.parseInt(row.value, 10) : 0;
  } catch {
    // meta table doesn't exist yet → fresh database
    return 0;
  }
}
