import type { Database } from "better-sqlite3";

export const INDEX_SCHEMA_VERSION = 9;

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

INSERT INTO meta (key, value) VALUES ('schema_version', '9');

CREATE TABLE doco_root (
  id              TEXT PRIMARY KEY,
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
  doco_id        TEXT NOT NULL,
  summary         TEXT NOT NULL,
  type            TEXT NOT NULL,
  username        TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  owner_id        TEXT,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  lifecycle       TEXT,
  raw_json        TEXT NOT NULL
);

CREATE TABLE intent (
  id                TEXT PRIMARY KEY,
  doco_id          TEXT NOT NULL,
  summary           TEXT NOT NULL,
  title             TEXT NOT NULL,
  parent_intent_id  TEXT,
  priority          TEXT,
  created_at        TEXT NOT NULL,
  created_by        TEXT NOT NULL,
  lifecycle         TEXT,
  raw_json          TEXT NOT NULL
);

CREATE TABLE rule (
  id              TEXT PRIMARY KEY,
  doco_id        TEXT NOT NULL,
  summary         TEXT NOT NULL,
  modality        TEXT NOT NULL,
  severity        TEXT,
  phase           TEXT NOT NULL,
  on_violation    TEXT,
  predicate       TEXT,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  lifecycle       TEXT,
  born_from       TEXT,
  raw_json        TEXT NOT NULL
);

CREATE TABLE decision (
  id              TEXT PRIMARY KEY,
  doco_id        TEXT NOT NULL,
  summary         TEXT NOT NULL,
  question        TEXT NOT NULL,
  chosen          TEXT,
  decided_by      TEXT NOT NULL,
  decided_at      TEXT NOT NULL,
  superseded_by   TEXT,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  lifecycle       TEXT,
  raw_json        TEXT NOT NULL
);

CREATE TABLE action (
  id              TEXT PRIMARY KEY,
  doco_id        TEXT NOT NULL,
  summary         TEXT NOT NULL,
  actor_id        TEXT NOT NULL,
  verb            TEXT NOT NULL,
  target          TEXT,
  started_at      TEXT,
  ended_at        TEXT,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  lifecycle       TEXT,
  raw_json        TEXT NOT NULL
);

CREATE TABLE reasoning (
  id              TEXT PRIMARY KEY,
  doco_id        TEXT NOT NULL,
  summary         TEXT NOT NULL,
  author_id       TEXT NOT NULL,
  conclusion_ref  TEXT,
  confidence      REAL,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  lifecycle       TEXT,
  raw_json        TEXT NOT NULL
);

-- Eval — test/eval definition. Replaces both the EVO placeholder name
-- and the dropped 'evaluation' node type (which was unused — run history
-- lives outside the Doco in CI / the runner). The runner updates
-- last_run_at + last_status in place; per-run history is not persisted.
CREATE TABLE eval (
  id              TEXT PRIMARY KEY,
  doco_id         TEXT NOT NULL,
  summary         TEXT NOT NULL,
  name            TEXT NOT NULL,
  target_ref      TEXT,
  criterion_kind  TEXT NOT NULL,
  last_run_at     TEXT,
  last_status     TEXT,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  lifecycle       TEXT,
  raw_json        TEXT NOT NULL
);

CREATE TABLE reference (
  id              TEXT PRIMARY KEY,
  doco_id        TEXT NOT NULL,
  summary         TEXT NOT NULL,
  ref_type        TEXT NOT NULL,
  locator         TEXT NOT NULL,
  content_hash    TEXT,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  lifecycle       TEXT,
  raw_json        TEXT NOT NULL
);

CREATE TABLE scope (
  id              TEXT PRIMARY KEY,
  doco_id        TEXT NOT NULL,
  summary         TEXT NOT NULL,
  name            TEXT NOT NULL UNIQUE,
  description     TEXT,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  lifecycle       TEXT,
  raw_json        TEXT NOT NULL
);
CREATE INDEX scope_lifecycle_idx ON scope(lifecycle);

CREATE TABLE idea (
  id                TEXT PRIMARY KEY,
  doco_id          TEXT NOT NULL,
  summary           TEXT NOT NULL,
  body              TEXT,
  proposer_id       TEXT,
  promoted_to       TEXT,
  rejection_reason  TEXT,
  created_at        TEXT NOT NULL,
  created_by        TEXT NOT NULL,
  lifecycle         TEXT,
  raw_json          TEXT NOT NULL
);

CREATE TABLE organization (
  id              TEXT PRIMARY KEY,
  doco_id        TEXT NOT NULL,
  summary         TEXT NOT NULL,
  slug            TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  description     TEXT,
  visibility      TEXT,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  lifecycle       TEXT,
  raw_json        TEXT NOT NULL
);
CREATE INDEX organization_slug_idx ON organization(slug);

-- Indexes for common queries
CREATE INDEX intent_lifecycle_idx    ON intent(lifecycle);
CREATE INDEX rule_phase_idx          ON rule(phase, modality);
CREATE INDEX rule_born_from_idx      ON rule(born_from);
CREATE INDEX decision_lifecycle_idx  ON decision(lifecycle);
CREATE INDEX decision_decided_at_idx ON decision(decided_at);
CREATE INDEX action_actor_idx        ON action(actor_id);
CREATE INDEX action_verb_idx         ON action(verb);
CREATE INDEX eval_target_idx         ON eval(target_ref);
CREATE INDEX eval_last_status_idx    ON eval(last_status);

-- Cross-cutting: edges derived from ID-shaped fields (D-017 fields-as-edges).
-- edge_type values include: serves, consults, enacts, performed_by, acts_on,
--   authored_by, premise, concludes, has_parent, has_stakeholder, owned_by,
--   created_by, updated_by, born_from, superseded_by, evaluates_rule,
--   evaluated_on, in_scope_of (was 'tagged' pre-ADR-078), member_of,
--   follows  (ADR-077: BPMN ordering).
CREATE TABLE edges (
  from_id         TEXT NOT NULL,
  from_node_type  TEXT NOT NULL,
  to_id           TEXT NOT NULL,
  to_node_type    TEXT NOT NULL,
  edge_type       TEXT NOT NULL,
  edge_props_json TEXT,
  -- 'explicit' (declared in source frontmatter) | 'doco-auto' (LLM-detected).
  -- Per the 'llm-auto-edge-detection-on-capture' + 'pagerank-weights-
  -- explicit-edges-higher' ADRs. Defaults to 'explicit' so legacy rows
  -- migrate cleanly.
  attribution     TEXT NOT NULL DEFAULT 'explicit',
  PRIMARY KEY (from_id, to_id, edge_type)
);
CREATE INDEX edges_to_idx ON edges(to_id, edge_type);
CREATE INDEX edges_from_type_idx ON edges(from_id, edge_type);
CREATE INDEX edges_type_idx ON edges(edge_type);
CREATE INDEX edges_attribution_idx ON edges(attribution);

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

-- Vector embeddings (ADR-052). One row per entity, keyed by entity_id.
-- The model_id + content_hash columns let the reindex hook skip work when
-- nothing changed; a model swap invalidates rows whose model_id differs
-- from the current provider's. The embedding BLOB is a Float32Array
-- serialized little-endian (e.g. 1536 dims × 4 bytes = 6144 bytes for the
-- default OpenAI text-embedding-3-small model).
CREATE TABLE embeddings (
  entity_id     TEXT PRIMARY KEY,
  doco_id       TEXT NOT NULL,
  model_id      TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  embedding     BLOB NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX embeddings_model_idx ON embeddings(model_id);
`;

export function migrate(db: Database): void {
  const currentVersion = getVersion(db);
  if (currentVersion >= INDEX_SCHEMA_VERSION) return;
  if (currentVersion === 0) {
    db.exec(MIGRATION_V1);
    return;
  }
  // Older → current: drop + rebuild. The cache is regenerable from source
  // files (reindex re-walks the Doco). Simple while we're still in v0.x.
  if (currentVersion < INDEX_SCHEMA_VERSION) {
    rebuildFromScratch(db);
    db.exec(MIGRATION_V1);
    return;
  }
  throw new Error(
    `Cannot upgrade index schema from version ${currentVersion} to ${INDEX_SCHEMA_VERSION}: no migration path defined.`,
  );
}

function rebuildFromScratch(db: Database): void {
  const tables = [
    "edges",
    "scope_match",
    "embeddings",
    "principal",
    "intent",
    "rule",
    "decision",
    "action",
    "reasoning",
    // Legacy tables — kept in the drop list so v3→v4 migrations clean them.
    "evaluation",
    "evo",
    // Current.
    "eval",
    "reference",
    "scope",
    "idea",
    "organization",
    "doco_root",
    "meta",
  ];
  for (const t of tables) {
    try {
      db.exec(`DROP TABLE IF EXISTS ${t}`);
    } catch {
      /* ignore */
    }
  }
  try {
    db.exec(`DROP TABLE IF EXISTS fts`);
  } catch {
    /* ignore */
  }
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
