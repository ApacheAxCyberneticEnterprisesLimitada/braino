-- Doco Postgres schema (decision_01KRKEVEE3RQGPWHAPMZ0MS9G9).
--
-- Source-of-truth + read-side index in one database per host. Replaces
-- the filesystem-and-git shape that ADR-023 / ADR-024 described.
--
-- Single-database, multi-tenant: every entity carries its `doco_id`
-- which scopes it to the owning Doco. Hosts can hold thousands of
-- Docos in one database.
--
-- Schema rules:
--   - Each entity type gets its own table; common columns live up top
--     in a consistent order (id, doco_id, summary, lifecycle, ...).
--   - Type-specific columns are appended.
--   - `body_md` is on the types that have a markdown narrative body.
--   - `edges` materializes cross-entity references for graph queries.
--   - `audit_events` is the structured history (decision_01KRKESCBTYG4005VMPKYNYR53).

-- Schema version. Tracked separately from app version so DB migrations
-- don't gate code releases. v1 = initial Phase 2 cut.
CREATE TABLE IF NOT EXISTS doco_meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);
INSERT INTO doco_meta (key, value) VALUES ('schema_version', '1') ON CONFLICT DO NOTHING;

-- Host config (singleton row at id='host'). Replaces <root>/host.yaml
-- (rule_01KRKQDHWNWJAF4YKTMCB2A0D9 — alpha forbids back-compat).
CREATE TABLE IF NOT EXISTS hosts (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  visibility  text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  raw_yaml    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Identity layer.

CREATE TABLE IF NOT EXISTS principals (
  id              text PRIMARY KEY,
  username        text NOT NULL UNIQUE,
  type            text NOT NULL CHECK (type IN ('human', 'agent')),
  display_name    text,
  email           text,
  github_login    text,
  avatar_url      text,
  owner_id        text REFERENCES principals(id) ON DELETE SET NULL,
  raw_yaml        text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deactivated_at  timestamptz
);

CREATE TABLE IF NOT EXISTS organizations (
  id          text PRIMARY KEY,
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  raw_yaml    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Organization membership (replaces members[] array inside organizations.yaml).
-- Must come after both `principals` and `organizations` — its FKs reference them.
CREATE TABLE IF NOT EXISTS org_members (
  org_id        text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  principal_id  text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, principal_id)
);
CREATE INDEX IF NOT EXISTS org_members_principal_idx ON org_members (principal_id, role);

CREATE TABLE IF NOT EXISTS docos (
  id              text PRIMARY KEY,
  owner_slug      text NOT NULL,
  doco_slug       text NOT NULL,
  owner_id        text NOT NULL,    -- principal_<ulid> OR organization_<ulid>
  name            text,
  visibility      text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  raw_yaml        text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_slug, doco_slug)
);

-- Per-Doco entity tables. `body_md` carries the markdown narrative
-- on types that have one; the rest of the structured data lives in
-- `raw_yaml` (round-trippable to/from the legacy file format).

CREATE TABLE IF NOT EXISTS intents (
  id          text PRIMARY KEY,
  doco_id     text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  summary     text,
  lifecycle   text,
  body_md     text,
  raw_yaml    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
CREATE INDEX IF NOT EXISTS intents_doco_idx ON intents (doco_id, created_at DESC);
CREATE INDEX IF NOT EXISTS intents_lifecycle_idx ON intents (doco_id, lifecycle);

CREATE TABLE IF NOT EXISTS decisions (
  id          text PRIMARY KEY,
  doco_id     text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  summary     text,
  lifecycle   text,
  body_md     text,
  raw_yaml    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
CREATE INDEX IF NOT EXISTS decisions_doco_idx ON decisions (doco_id, created_at DESC);
CREATE INDEX IF NOT EXISTS decisions_lifecycle_idx ON decisions (doco_id, lifecycle);

CREATE TABLE IF NOT EXISTS rules (
  id          text PRIMARY KEY,
  doco_id     text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  summary     text,
  lifecycle   text,
  body_md     text,
  raw_yaml    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
CREATE INDEX IF NOT EXISTS rules_doco_idx ON rules (doco_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rules_lifecycle_idx ON rules (doco_id, lifecycle);

CREATE TABLE IF NOT EXISTS actions (
  id          text PRIMARY KEY,
  doco_id     text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  summary     text,
  lifecycle   text,
  body_md     text,
  raw_yaml    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
CREATE INDEX IF NOT EXISTS actions_doco_idx ON actions (doco_id, created_at DESC);
CREATE INDEX IF NOT EXISTS actions_lifecycle_idx ON actions (doco_id, lifecycle);

CREATE TABLE IF NOT EXISTS reasoning (
  id          text PRIMARY KEY,
  doco_id     text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  summary     text,
  lifecycle   text,
  body_md     text,
  raw_yaml    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
CREATE INDEX IF NOT EXISTS reasoning_doco_idx ON reasoning (doco_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reasoning_lifecycle_idx ON reasoning (doco_id, lifecycle);

CREATE TABLE IF NOT EXISTS evals (
  id          text PRIMARY KEY,
  doco_id     text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  summary     text,
  lifecycle   text,
  body_md     text,
  raw_yaml    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
CREATE INDEX IF NOT EXISTS evals_doco_idx ON evals (doco_id, created_at DESC);
CREATE INDEX IF NOT EXISTS evals_lifecycle_idx ON evals (doco_id, lifecycle);

CREATE TABLE IF NOT EXISTS scopes (
  id          text PRIMARY KEY,
  doco_id     text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  name        text NOT NULL,
  summary     text,
  lifecycle   text,
  raw_yaml    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text,
  UNIQUE (doco_id, name)
);
CREATE INDEX IF NOT EXISTS scopes_doco_idx ON scopes (doco_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tags (
  id          text PRIMARY KEY,
  doco_id     text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  name        text NOT NULL,
  raw_yaml    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doco_id, name)
);

CREATE TABLE IF NOT EXISTS ideas (
  id          text PRIMARY KEY,
  doco_id     text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  summary     text,
  lifecycle   text,
  body_md     text,
  raw_yaml    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

CREATE TABLE IF NOT EXISTS reference_entities (
  id          text PRIMARY KEY,
  doco_id     text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  summary     text,
  lifecycle   text,
  raw_yaml    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

-- Doco-level Principal/Organization references (multi-tenant Principals
-- live in the host-level `principals` table above, but a Doco can record
-- which Principals are members for permissions). For Phase 2, we just
-- mirror the YAML files; full membership table comes later.

-- Audit events: structured replacement for git history
-- (decision_01KRKESCBTYG4005VMPKYNYR53). One row per mutation.

CREATE TABLE IF NOT EXISTS audit_events (
  event_id      text PRIMARY KEY,
  at            timestamptz NOT NULL,
  by_principal  text,
  doco_id       text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  entity_type   text NOT NULL,
  entity_id     text NOT NULL,
  op            text NOT NULL CHECK (op IN ('entity.create', 'entity.update', 'entity.delete', 'lifecycle.transition', 'edge.add')),
  before_json   jsonb,
  after_json    jsonb,
  reason        text
);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events (entity_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_events_doco_idx ON audit_events (doco_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_events_op_idx ON audit_events (doco_id, op, at DESC);
CREATE INDEX IF NOT EXISTS audit_events_actor_idx ON audit_events (by_principal, at DESC);

-- Indexing layer tables. These hold the derived-data the read side
-- consumes — graph edges, vector embeddings, denormalized rule targets,
-- and full-text search rows. Supersedes ADR-023 (tiered architecture)
-- and ADR-024 (SQLite + FTS5) — Postgres is now both source of truth
-- and read-side index.

-- Graph edges (ADR-025). Materialized from frontmatter ID-shaped fields
-- by the indexer. attribution=='explicit' means declared in source;
-- 'doco-auto' means LLM-detected. Doco-scoped via doco_id; both
-- endpoints can be any node_type so we can't FK them.
CREATE TABLE IF NOT EXISTS edges (
  from_id         text NOT NULL,
  from_node_type  text NOT NULL,
  to_id           text NOT NULL,
  to_node_type    text NOT NULL,
  edge_type       text NOT NULL,
  doco_id         text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  edge_props_json jsonb,
  attribution     text NOT NULL DEFAULT 'explicit' CHECK (attribution IN ('explicit', 'doco-auto')),
  PRIMARY KEY (from_id, to_id, edge_type)
);
CREATE INDEX IF NOT EXISTS edges_doco_idx        ON edges (doco_id);
CREATE INDEX IF NOT EXISTS edges_to_idx          ON edges (to_id, edge_type);
CREATE INDEX IF NOT EXISTS edges_from_type_idx   ON edges (from_id, edge_type);
CREATE INDEX IF NOT EXISTS edges_type_idx        ON edges (edge_type);
CREATE INDEX IF NOT EXISTS edges_attribution_idx ON edges (attribution);

-- Vector embeddings (ADR-052). One row per entity. Storage is bytea
-- (Float32Array bytes, little-endian). pgvector + ivfflat/hnsw is an
-- additive optimization for Tier-C scale (currently Tier B per ADR-049,
-- where sequential cosine is microseconds). Switching to vector(N) later
-- is a column-type migration with no data reformat.
-- model_id + content_hash let the reindex hook skip work when nothing
-- changed; a model swap invalidates rows whose model_id differs.
CREATE TABLE IF NOT EXISTS embeddings (
  entity_id     text PRIMARY KEY,
  doco_id       text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  model_id      text NOT NULL,
  content_hash  text NOT NULL,
  embedding     bytea NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS embeddings_doco_idx  ON embeddings (doco_id);
CREATE INDEX IF NOT EXISTS embeddings_model_idx ON embeddings (model_id);

-- Denormalized Rule.applies_to → matched targets (ADR-026). Populated
-- by the indexer at write time. Lets runtime checks look up "which
-- Rules apply to this target?" in O(1) without re-evaluating selectors.
CREATE TABLE IF NOT EXISTS scope_match (
  source_id         text NOT NULL,
  source_node_type  text NOT NULL,
  target_id         text NOT NULL,
  target_node_type  text NOT NULL,
  doco_id           text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  selector_rev      integer NOT NULL DEFAULT 1,
  PRIMARY KEY (source_id, target_id)
);
CREATE INDEX IF NOT EXISTS scope_match_target_idx ON scope_match (target_id);
CREATE INDEX IF NOT EXISTS scope_match_doco_idx   ON scope_match (doco_id);

-- Full-text search. One row per
-- entity. The indexer populates summary + body; search_tsv is a
-- generated tsvector with English stemming and weighting (A=summary,
-- B=body). The GIN index handles `@@` queries efficiently.
CREATE TABLE IF NOT EXISTS entity_fts (
  entity_id   text PRIMARY KEY,
  doco_id     text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  node_type   text NOT NULL,
  summary     text,
  body        text,
  search_tsv  tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(summary, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'B')
  ) STORED
);
CREATE INDEX IF NOT EXISTS entity_fts_doco_idx ON entity_fts (doco_id);
CREATE INDEX IF NOT EXISTS entity_fts_tsv_idx  ON entity_fts USING gin (search_tsv);

-- Drop the legacy `revision` column from entity tables. Was incremented
-- on every upsert but never read by any TS code (decision_01KRHBZMD0V35NAX94Y7N2MXVA
-- flagged it; never fully retired). Idempotent — no-op on fresh DBs.
ALTER TABLE intents            DROP COLUMN IF EXISTS revision;
ALTER TABLE decisions          DROP COLUMN IF EXISTS revision;
ALTER TABLE rules              DROP COLUMN IF EXISTS revision;
ALTER TABLE actions            DROP COLUMN IF EXISTS revision;
ALTER TABLE reasoning          DROP COLUMN IF EXISTS revision;
ALTER TABLE evals              DROP COLUMN IF EXISTS revision;
ALTER TABLE scopes             DROP COLUMN IF EXISTS revision;
ALTER TABLE ideas              DROP COLUMN IF EXISTS revision;
ALTER TABLE reference_entities DROP COLUMN IF EXISTS revision;

-- ──────────────────────────────────────────────────────────────────────────
-- Token store (session tokens + CLI authorizations). The legacy filesystem
-- form was one JSON file per host; this is a single-row blob per key,
-- keyed by the path that the filesystem version used. Hacky but mirrors
-- the original semantics exactly. Move to one-row-per-token tables once
-- the surface stabilizes.
CREATE TABLE IF NOT EXISTS tokens_blob (
  key        text PRIMARY KEY,
  blob       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
