-- Doco Postgres schema (decision_01KRKEVEE3RQGPWHAPMZ0MS9G9).
--
-- Source-of-truth + read-side index in one database per host. Replaces
-- the filesystem-and-git shape that ADR-023 / ADR-024 described.
--
-- Single-database, multi-tenant: every entity carries its `doco_id`
-- which scopes it to the owning Doco. Hosts can hold thousands of
-- Doco instances in one database.
--
-- Schema rules:
--   - Each entity type gets its own table; common columns live up top
--     in a consistent order (id, doco_id, summary, lifecycle, ...).
--   - Type-specific columns are appended.
--   - `body_md` is on the types that have a markdown narrative body.
--   - `synapses` materializes cross-entity references for graph queries
--     (renamed from `synapses` in migration 005).
--   - `audit_events` is the structured history (decision_01KRKESCBTYG4005VMPKYNYR53).
--   - Historical DO/ALTER convergence blocks below are retained for old
--     databases. New schema changes belong in packages/db/migrations/.
--
-- Vocabulary (post-migration-005):
--   neurons   — graph entities (10 types: intent/idea/rule/decision/action/
--               log/eval/reference/state/principal)
--   primitives — constitution metadata (2 kinds: guidance / neuron_authoring)
--   synapses   — relationships between neurons
--   collaborators — OAuth identities (person/agent), separate from principals
--                   (which are role-personas referenced by actor_id/actors[]).

-- Schema version. Tracked separately from app version so DB migrations
-- don't gate code releases. v1 = initial Phase 2 cut.
CREATE TABLE IF NOT EXISTS doco_meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);
INSERT INTO doco_meta (key, value) VALUES ('schema_version', '1') ON CONFLICT DO NOTHING;

-- Forward-only migration ledger. Populated by `applyMigrations()` in
-- packages/db/src/migrations.ts. New schema changes go in
-- `packages/db/migrations/NNN_short_name.sql`, not into this file.
CREATE TABLE IF NOT EXISTS applied_migrations (
  id          text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- v9 rename: per the constitution's "use 'user' as the inclusive term"
-- rule, the membership tables drop the legacy "_members" suffix and read
-- as "_users". Tables, indexes, and CHECK constraints rename in one
-- idempotent DO block — ALTER ... IF EXISTS so fresh DBs no-op cleanly.
-- This block MUST run before any CREATE TABLE that references the new
-- names; on existing DBs it renames first, then those CREATEs are noops.
DO $v9_user_rename$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'doco_members') THEN
    ALTER TABLE doco_members RENAME TO doco_users;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'doco_members_principal_idx') THEN
    ALTER INDEX doco_members_principal_idx RENAME TO doco_users_collaborator_idx;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'org_members') THEN
    ALTER TABLE org_members RENAME TO org_users;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'org_members_principal_idx') THEN
    ALTER INDEX org_members_principal_idx RENAME TO org_users_collaborator_idx;
  END IF;

  -- Constraints don't auto-rename when tables rename.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_members_role_check') THEN
    ALTER TABLE org_users RENAME CONSTRAINT org_members_role_check TO org_users_role_check;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'doco_members_role_check') THEN
    ALTER TABLE doco_users RENAME CONSTRAINT doco_members_role_check TO doco_users_role_check;
  END IF;
END
$v9_user_rename$;

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

-- Default host row. Every Doco install needs exactly one. Without it,
-- loadHostConfig() throws "No host config in Postgres" on the first
-- request after a fresh schema, which 500s every page that calls it
-- (including /onboarding/create/human — the page new visitors hit).
-- The ON CONFLICT keeps this idempotent: existing installs keep their
-- custom host config untouched.
INSERT INTO hosts (id, name, visibility, raw_yaml)
VALUES ('host', 'Doco', 'public', '{"id":"host","name":"Doco","visibility":"public"}')
ON CONFLICT (id) DO NOTHING;

-- Identity layer.
--
-- Two distinct concerns, split into two tables (migration 005):
--   `collaborators` — OAuth identity (person or agent runtime that holds
--                     auth tokens). Authored neurons via `created_by` /
--                     `updated_by`. Members of orgs/docos.
--   `principals`    — role-personas (the "actor" in a documented business
--                     process). Referenced by Action.actor_id, Log.actor_id,
--                     Intent.actors[], etc. Modeled as a neuron type.

CREATE TABLE IF NOT EXISTS collaborators (
  id              text PRIMARY KEY,            -- collaborator_<ulid>
  kind            text NOT NULL CHECK (kind IN ('person', 'agent')),
  github_id       text,                        -- GitHub numeric id (immutable)
  github_login    text,                        -- current GitHub login (mutable)
  email           text,
  avatar_url      text,
  owner_id        text REFERENCES collaborators(id) ON DELETE SET NULL,
  raw_yaml        text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deactivated_at  timestamptz
);
CREATE INDEX IF NOT EXISTS collaborators_github_login_idx ON collaborators (github_login);
CREATE INDEX IF NOT EXISTS collaborators_kind_idx          ON collaborators (kind);

CREATE TABLE IF NOT EXISTS principals (
  id              text PRIMARY KEY,            -- principal_<ulid>
  username        text NOT NULL UNIQUE,        -- role string (e.g. "system",
                                               -- "customer-service-rep")
  -- Principals are host-scoped (no doco_id NOT NULL) so role-personas can
  -- be shared across Docos. The optional doco_id, set lazily when a role
  -- is authored within a specific Doco, lives in raw_yaml and is hydrated
  -- at read time by the repo. No FK constraint to avoid a forward ref to
  -- the docos table that is created later in this file.
  summary         text,
  lifecycle       text,
  body_md         text,
  raw_yaml        text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text,                        -- collaborator_<ulid>
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      text
);

CREATE TABLE IF NOT EXISTS organizations (
  id          text PRIMARY KEY,
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  raw_yaml    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Organization users (per-org role grants). Pre-v9 this table was named
-- `org_members`; the v9 rename DO block at the top of this file renames
-- existing installs in place. Fresh installs land here directly.
CREATE TABLE IF NOT EXISTS org_users (
  org_id        text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  collaborator_id  text NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, collaborator_id)
);
CREATE INDEX IF NOT EXISTS org_users_collaborator_idx ON org_users (collaborator_id, role);

-- Slug removal — every Doco has a single human-readable identifier:
-- `handle`. It lives in the same flat global namespace as the
-- top-level host routes (HOST_RESERVED_SLUGS in
-- @doco/shared/url-conventions.ts). On create, callers pass a
-- `requested_id` and the host auto-suffixes (-2, -3, …) on
-- collision. The internal ULID `id` stays as the FK target for
-- every entity table; `handle` is what URLs and the public API
-- key off.
--
-- Phase 1–2d of the cut introduced `handle` alongside the legacy
-- `(owner_slug, doco_slug)` pair. Phase 3a (this snapshot) drops
-- the legacy columns + their composite UNIQUE. mapDocoRow in
-- @doco/db synthesizes a back-compat `owner_slug` field via a
-- LEFT JOIN to `principals.username` / `organizations.slug`
-- keyed by `owner_id`; back-compat `doco_slug` is just an alias
-- for `handle`.
CREATE TABLE IF NOT EXISTS docos (
  id              text PRIMARY KEY,
  handle          text,
  owner_id        text NOT NULL,    -- principal_<ulid> OR organization_<ulid>
  name            text,
  visibility      text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  raw_yaml        text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Phase 3a migration: backfill `handle` from the legacy slug pair
-- for any pre-handle rows, drop the composite UNIQUE, drop the
-- columns. Idempotent — no-op on fresh DBs (the columns won't
-- exist) and on already-migrated DBs (the constraint is gone).
ALTER TABLE docos ADD COLUMN IF NOT EXISTS handle text;
DO $migrate$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'docos' AND column_name = 'owner_slug'
  ) THEN
    UPDATE docos SET handle = COALESCE(handle, owner_slug || '-' || doco_slug)
     WHERE handle IS NULL;
  END IF;
END
$migrate$;
ALTER TABLE docos DROP CONSTRAINT IF EXISTS docos_owner_slug_doco_slug_key;
ALTER TABLE docos DROP COLUMN IF EXISTS owner_slug;
ALTER TABLE docos DROP COLUMN IF EXISTS doco_slug;
DO $uniq$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'docos_handle_key'
  ) THEN
    ALTER TABLE docos ADD CONSTRAINT docos_handle_key UNIQUE (handle);
  END IF;
END
$uniq$;

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

CREATE TABLE IF NOT EXISTS guidance_primitives (
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
CREATE INDEX IF NOT EXISTS guidance_primitives_doco_idx
  ON guidance_primitives (doco_id, created_at DESC);
CREATE INDEX IF NOT EXISTS guidance_primitives_lifecycle_idx
  ON guidance_primitives (doco_id, lifecycle);

CREATE TABLE IF NOT EXISTS neuron_authoring_primitives (
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
CREATE INDEX IF NOT EXISTS neuron_authoring_primitives_doco_idx
  ON neuron_authoring_primitives (doco_id, created_at DESC);
CREATE INDEX IF NOT EXISTS neuron_authoring_primitives_lifecycle_idx
  ON neuron_authoring_primitives (doco_id, lifecycle);

-- Org-level constitution articles. Mirror the per-Doco shape but key on
-- `org_id` instead of `doco_id`. An org's constitution applies to every
-- Doco it owns, so the agent bootstrap aggregates these alongside the
-- per-Doco constitutions for any org/doco the caller can read.
CREATE TABLE IF NOT EXISTS org_guidance_primitives (
  id          text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  summary     text,
  lifecycle   text,
  body_md     text,
  raw_yaml    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
CREATE INDEX IF NOT EXISTS org_guidance_primitives_org_idx
  ON org_guidance_primitives (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS org_guidance_primitives_lifecycle_idx
  ON org_guidance_primitives (org_id, lifecycle);

CREATE TABLE IF NOT EXISTS org_neuron_authoring_primitives (
  id          text PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  summary     text,
  lifecycle   text,
  body_md     text,
  raw_yaml    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
CREATE INDEX IF NOT EXISTS org_neuron_authoring_primitives_org_idx
  ON org_neuron_authoring_primitives (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS org_neuron_authoring_primitives_lifecycle_idx
  ON org_neuron_authoring_primitives (org_id, lifecycle);

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

CREATE TABLE IF NOT EXISTS logs (
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
CREATE INDEX IF NOT EXISTS logs_doco_idx ON logs (doco_id, created_at DESC);
CREATE INDEX IF NOT EXISTS logs_lifecycle_idx ON logs (doco_id, lifecycle);

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

-- Per decision_01KRRR5BQ16ASY8HQEE0V499YG (v7) — State is a node in a
-- formal state machine. Mirrors the actions table shape; the structured
-- frontmatter (`kind`, `invariants`) lives in raw_yaml.
CREATE TABLE IF NOT EXISTS states (
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
CREATE INDEX IF NOT EXISTS states_doco_idx ON states (doco_id, created_at DESC);
CREATE INDEX IF NOT EXISTS states_lifecycle_idx ON states (doco_id, lifecycle);

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
  by_collaborator  text,
  doco_id       text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  entity_type   text NOT NULL,
  entity_id     text NOT NULL,
  op            text NOT NULL CHECK (op IN ('entity.create', 'entity.update', 'entity.delete', 'lifecycle.transition', 'synapse.add')),
  before_json   jsonb,
  after_json    jsonb,
  reason        text
);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events (entity_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_events_doco_idx ON audit_events (doco_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_events_op_idx ON audit_events (doco_id, op, at DESC);
CREATE INDEX IF NOT EXISTS audit_events_collaborator_idx ON audit_events (by_collaborator, at DESC);

-- Org-scope audit events: org constitutions are first-class node-like
-- entries (audit-tracked even though they don't live in a Doco). For
-- those rows, `org_id` is set and `doco_id` is NULL.
ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE audit_events ALTER COLUMN doco_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS audit_events_org_idx ON audit_events (org_id, at DESC);

-- Indexing layer tables. These hold the derived-data the read side
-- consumes — graph synapses, vector embeddings, denormalized rule targets,
-- and full-text search rows. Supersedes ADR-023 (tiered architecture)
-- and ADR-024 (SQLite + FTS5) — Postgres is now both source of truth
-- and read-side index.

-- Graph synapses (ADR-025). Materialized from frontmatter ID-shaped fields
-- by the indexer. attribution=='explicit' means declared in source;
-- 'doco-auto' means LLM-detected. Doco-scoped via doco_id; both
-- endpoints can be any neuron_type so we can't FK them.
CREATE TABLE IF NOT EXISTS synapses (
  from_id         text NOT NULL,
  from_neuron_type  text NOT NULL,
  to_id           text NOT NULL,
  to_neuron_type    text NOT NULL,
  synapse_type       text NOT NULL,
  doco_id         text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  synapse_props_json jsonb,
  attribution     text NOT NULL DEFAULT 'explicit' CHECK (attribution IN ('explicit', 'doco-auto')),
  PRIMARY KEY (from_id, to_id, synapse_type)
);
CREATE INDEX IF NOT EXISTS synapses_doco_idx        ON synapses (doco_id);
CREATE INDEX IF NOT EXISTS synapses_to_idx          ON synapses (to_id, synapse_type);
CREATE INDEX IF NOT EXISTS synapses_from_type_idx   ON synapses (from_id, synapse_type);
CREATE INDEX IF NOT EXISTS synapses_type_idx        ON synapses (synapse_type);
CREATE INDEX IF NOT EXISTS synapses_attribution_idx ON synapses (attribution);
CREATE INDEX IF NOT EXISTS synapses_doco_type_from_idx ON synapses (doco_id, synapse_type, from_id);
CREATE INDEX IF NOT EXISTS synapses_doco_type_to_idx   ON synapses (doco_id, synapse_type, to_id);

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

-- Full-text search. Five tables (one per top-level entity category) so the
-- search filter logic can pick the right shape directly. The indexer
-- populates summary + body; search_tsv is a generated tsvector with English
-- stemming and weighting (A=summary, B=body). A GIN index per table handles
-- `@@` queries efficiently. Cross-category search is a UNION over tables.

CREATE TABLE IF NOT EXISTS entity_fts_neurons (
  entity_id    text PRIMARY KEY,
  doco_id      text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  neuron_type  text NOT NULL,
  summary      text,
  body         text,
  search_tsv   tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(summary, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'B')
  ) STORED
);
CREATE INDEX IF NOT EXISTS entity_fts_neurons_doco_idx ON entity_fts_neurons (doco_id);
CREATE INDEX IF NOT EXISTS entity_fts_neurons_tsv_idx  ON entity_fts_neurons USING gin (search_tsv);

CREATE TABLE IF NOT EXISTS entity_fts_primitives (
  entity_id       text PRIMARY KEY,
  doco_id         text REFERENCES docos(id) ON DELETE CASCADE,
  org_id          text REFERENCES organizations(id) ON DELETE CASCADE,
  primitive_kind  text NOT NULL CHECK (primitive_kind IN ('guidance', 'neuron_authoring')),
  summary         text,
  body            text,
  search_tsv      tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(summary, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'B')
  ) STORED,
  CHECK ((doco_id IS NOT NULL) OR (org_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS entity_fts_primitives_doco_idx ON entity_fts_primitives (doco_id);
CREATE INDEX IF NOT EXISTS entity_fts_primitives_org_idx  ON entity_fts_primitives (org_id);
CREATE INDEX IF NOT EXISTS entity_fts_primitives_tsv_idx  ON entity_fts_primitives USING gin (search_tsv);

CREATE TABLE IF NOT EXISTS entity_fts_collaborators (
  entity_id   text PRIMARY KEY,
  summary     text,
  body        text,
  search_tsv  tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(summary, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'B')
  ) STORED
);
CREATE INDEX IF NOT EXISTS entity_fts_collaborators_tsv_idx ON entity_fts_collaborators USING gin (search_tsv);

CREATE TABLE IF NOT EXISTS entity_fts_docos (
  entity_id   text PRIMARY KEY,
  summary     text,
  body        text,
  search_tsv  tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(summary, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'B')
  ) STORED
);
CREATE INDEX IF NOT EXISTS entity_fts_docos_tsv_idx ON entity_fts_docos USING gin (search_tsv);

CREATE TABLE IF NOT EXISTS entity_fts_organizations (
  entity_id   text PRIMARY KEY,
  summary     text,
  body        text,
  search_tsv  tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(summary, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'B')
  ) STORED
);
CREATE INDEX IF NOT EXISTS entity_fts_organizations_tsv_idx ON entity_fts_organizations USING gin (search_tsv);

-- Drop the legacy `revision` column from entity tables. Was incremented
-- on every upsert but never read by any TS code (decision_01KRHBZMD0V35NAX94Y7N2MXVA
-- flagged it; never fully removed). Idempotent — no-op on fresh DBs.
ALTER TABLE intents            DROP COLUMN IF EXISTS revision;
ALTER TABLE decisions          DROP COLUMN IF EXISTS revision;
ALTER TABLE rules              DROP COLUMN IF EXISTS revision;
ALTER TABLE guidance_primitives  DROP COLUMN IF EXISTS revision;
ALTER TABLE neuron_authoring_primitives DROP COLUMN IF EXISTS revision;
ALTER TABLE actions            DROP COLUMN IF EXISTS revision;
ALTER TABLE evals              DROP COLUMN IF EXISTS revision;
ALTER TABLE ideas              DROP COLUMN IF EXISTS revision;
ALTER TABLE reference_entities DROP COLUMN IF EXISTS revision;

-- Deprecation (2026-05-16): the `reasoning` node type was removed.
-- Drop the legacy table and purge any dangling synapses / embeddings /
-- audit rows so existing databases converge to the new shape on boot.
-- Idempotent — no-op on fresh DBs.
DROP TABLE IF EXISTS reasoning CASCADE;
DELETE FROM synapses         WHERE from_id LIKE 'reasoning\_%' ESCAPE '\' OR to_id LIKE 'reasoning\_%' ESCAPE '\';
DELETE FROM embeddings    WHERE entity_id LIKE 'reasoning\_%' ESCAPE '\';
DELETE FROM audit_events  WHERE entity_id LIKE 'reasoning\_%' ESCAPE '\';

-- ──────────────────────────────────────────────────────────────────────────
-- Multi-level access (decision_01KS0JBJ5X0AZ4XJJFKEWE1R62).
--
-- Four roles (owner / approver / author / reader) granted at two levels
-- (org / doco). Effective role = max across levels (highest-wins
-- additive composition). Author-role writes default to lifecycle
-- `proposed`; only approver+ can transition.

-- Widen org_users.role CHECK to the new 4-role enum. Pre-existing rows
-- (owner|admin|member) collapse to 'owner' per the alpha-cutover posture.
-- Idempotent — DROP IF EXISTS covers both the legacy `org_members_role_check`
-- name (pre-v9) and the new `org_users_role_check`.
DO $org_role_widen$
BEGIN
  ALTER TABLE org_users DROP CONSTRAINT IF EXISTS org_members_role_check;
  ALTER TABLE org_users DROP CONSTRAINT IF EXISTS org_users_role_check;
  UPDATE org_users SET role = 'owner' WHERE role IN ('admin', 'member');
  ALTER TABLE org_users
    ADD CONSTRAINT org_users_role_check
    CHECK (role IN ('owner', 'approver', 'author', 'reader'));
END
$org_role_widen$;

-- Per-doco user grants. Invite redemption and owner/admin surfaces write
-- these rows directly; OAuth tokens authenticate callers but do not store
-- membership.
CREATE TABLE IF NOT EXISTS doco_users (
  doco_id       text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  collaborator_id  text NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner', 'approver', 'author', 'reader')),
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doco_id, collaborator_id)
);
CREATE INDEX IF NOT EXISTS doco_users_collaborator_idx ON doco_users (collaborator_id, role);

-- ──────────────────────────────────────────────────────────────────────────
-- Invite store backing blob. The old session-token and CLI authorization
-- shapes are ignored by the app; this table remains only because invites
-- are still stored as a compact host-level JSON document.
CREATE TABLE IF NOT EXISTS tokens_blob (
  key        text PRIMARY KEY,
  blob       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ──────────────────────────────────────────────────────────────────────────
-- OAuth 2.1 server (decision_01KS14CW9ZN23FF5CGG0Z7TH4G).
--
-- Replaces the DOCO_ACCESS-bearer-in-.env transport with a standard
-- MCP-OAuth handshake. The MCP server at /mcp returns
-- WWW-Authenticate: Bearer + resource_metadata pointer on 401; the
-- runtime discovers our /.well-known/oauth-authorization-server +
-- /.well-known/oauth-protected-resource endpoints, dynamically
-- registers itself (RFC 7591), opens the authorize URL in the user's
-- browser, exchanges the authorization code (+ PKCE verifier) for an
-- access + refresh token, and attaches Bearer on every subsequent
-- request.

-- Dynamically registered MCP clients (RFC 7591). One row per
-- registered runtime instance — Claude Code on machine A is a
-- different `client_id` than Claude Code on machine B because each
-- runtime issues its own registration request from its own keystore.
-- `client_secret` is NULL: OAuth 2.1 mandates PKCE for public
-- clients and forbids issuing secrets to anything that can't keep
-- them.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id        text PRIMARY KEY,
  client_name      text,
  redirect_uris    text[] NOT NULL,
  grant_types      text[] NOT NULL DEFAULT ARRAY['authorization_code','refresh_token'],
  response_types   text[] NOT NULL DEFAULT ARRAY['code'],
  token_endpoint_auth_method text NOT NULL DEFAULT 'none',
  software_id      text,
  software_version text,
  registered_at    timestamptz NOT NULL DEFAULT now()
);

-- Short-lived authorization codes (~60s TTL). Issued at /oauth/authorize
-- after the user approves the client, consumed at /oauth/token in
-- exchange for an access + refresh token. PKCE binds the code to the
-- runtime that requested it: `code_challenge` is the S256 hash of the
-- verifier the runtime stored locally; /oauth/token rejects the
-- exchange unless the verifier matches.
--
-- `granted_doco_ids` is the set of Docos the user approved this
-- client to access. Empty array means doco-level approval is pending
-- (rare path; we always require at least one Doco today).
CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code                  text PRIMARY KEY,
  client_id             text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  collaborator_id          text NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
  redirect_uri          text NOT NULL,
  code_challenge        text NOT NULL,
  code_challenge_method text NOT NULL DEFAULT 'S256' CHECK (code_challenge_method = 'S256'),
  granted_doco_ids      text[] NOT NULL,
  -- Per-Doco role scope-down. Map of doco_id → DocoRole capping the
  -- token's effective role on that Doco. The user can lower the role
  -- below what they themselves hold (give the agent "reader" on a Doco
  -- where they're owner) but never raise it. Missing entries mean
  -- "inherit the principal's actual role" — i.e. no scope-down.
  granted_doco_roles    jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Org-level grants. When the user approves access to an org, every
  -- Doco owned by that org becomes reachable through this token —
  -- including Docos created under the org after the token was minted
  -- ("live" grant, not a snapshot). `granted_org_roles[org_id]` caps
  -- the effective role on Docos under that org, same semantics as
  -- granted_doco_roles.
  granted_org_ids       text[] NOT NULL DEFAULT ARRAY[]::text[],
  granted_org_roles     jsonb NOT NULL DEFAULT '{}'::jsonb,
  scope                 text,
  expires_at            timestamptz NOT NULL,
  consumed_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_authorization_codes_expires_idx
  ON oauth_authorization_codes (expires_at);

-- Access tokens (~1h TTL). Opaque, server-issued, validated on every
-- MCP / API request by exact match. We don't use JWTs: tokens are
-- single-tenant (this host issues + validates them) and revocation
-- needs to be instantaneous, which JWT TTLs can't guarantee.
CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  token             text PRIMARY KEY,
  client_id         text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  collaborator_id      text NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
  granted_doco_ids  text[] NOT NULL,
  granted_doco_roles jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_org_ids   text[] NOT NULL DEFAULT ARRAY[]::text[],
  granted_org_roles jsonb NOT NULL DEFAULT '{}'::jsonb,
  scope             text,
  expires_at        timestamptz NOT NULL,
  revoked           boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_access_tokens_collaborator_idx
  ON oauth_access_tokens (collaborator_id, revoked);
CREATE INDEX IF NOT EXISTS oauth_access_tokens_expires_idx
  ON oauth_access_tokens (expires_at);

-- Refresh tokens (long-lived; 60-day default). Used by the runtime
-- when the access token expires; one round-trip to /oauth/token with
-- grant_type=refresh_token mints a fresh access token without
-- re-prompting the user.
--
-- Rotated on every refresh (the old token is marked revoked when a
-- new one is issued) to limit blast radius if a refresh token leaks.
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token             text PRIMARY KEY,
  client_id         text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  collaborator_id      text NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
  granted_doco_ids  text[] NOT NULL,
  granted_doco_roles jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_org_ids   text[] NOT NULL DEFAULT ARRAY[]::text[],
  granted_org_roles jsonb NOT NULL DEFAULT '{}'::jsonb,
  scope             text,
  expires_at        timestamptz NOT NULL,
  revoked           boolean NOT NULL DEFAULT false,
  superseded_by     text REFERENCES oauth_refresh_tokens(token) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_collaborator_idx
  ON oauth_refresh_tokens (collaborator_id, revoked);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_expires_idx
  ON oauth_refresh_tokens (expires_at);

-- Device Authorization Grant (RFC 8628). Designed for agents that
-- cannot drive a localhost-redirect OAuth flow (no port-binding,
-- no browser of their own): the agent calls
-- POST /oauth/device_authorization, displays the short `user_code`
-- to the human, then polls /oauth/token until the human approves
-- in their browser at GET /device.
--
-- `status` transitions: pending → approved (collaborator_id +
-- granted_doco_ids set) or denied or expired. The polling endpoint
-- mints + returns access/refresh tokens iff `status = approved`,
-- then deletes the row.
CREATE TABLE IF NOT EXISTS oauth_device_authorizations (
  device_code      text PRIMARY KEY,
  user_code        text NOT NULL UNIQUE,
  client_id        text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  scope            text,
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','denied')),
  collaborator_id     text REFERENCES collaborators(id) ON DELETE CASCADE,
  granted_doco_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  granted_doco_roles jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_org_ids  text[] NOT NULL DEFAULT ARRAY[]::text[],
  granted_org_roles jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at       timestamptz NOT NULL,
  last_polled_at   timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_device_authorizations_user_code_idx
  ON oauth_device_authorizations (user_code);
CREATE INDEX IF NOT EXISTS oauth_device_authorizations_expires_idx
  ON oauth_device_authorizations (expires_at);

-- Per-Doco role scope-down. Added after the OAuth tables shipped, so
-- guarded with IF NOT EXISTS to be idempotent on subsequent boots.
-- `CREATE TABLE IF NOT EXISTS` above doesn't ADD COLUMN on an
-- existing table; this block does.
ALTER TABLE oauth_authorization_codes
  ADD COLUMN IF NOT EXISTS granted_doco_roles jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE oauth_access_tokens
  ADD COLUMN IF NOT EXISTS granted_doco_roles jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE oauth_refresh_tokens
  ADD COLUMN IF NOT EXISTS granted_doco_roles jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE oauth_device_authorizations
  ADD COLUMN IF NOT EXISTS granted_doco_roles jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Org-level grants. A token can carry a list of org ids the user
-- approved; access then follows org-owned Docos live (including ones
-- created under the org after the token was minted). Same IF NOT EXISTS
-- guard for idempotent boot against existing deployments.
ALTER TABLE oauth_authorization_codes
  ADD COLUMN IF NOT EXISTS granted_org_ids text[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE oauth_authorization_codes
  ADD COLUMN IF NOT EXISTS granted_org_roles jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE oauth_access_tokens
  ADD COLUMN IF NOT EXISTS granted_org_ids text[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE oauth_access_tokens
  ADD COLUMN IF NOT EXISTS granted_org_roles jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE oauth_refresh_tokens
  ADD COLUMN IF NOT EXISTS granted_org_ids text[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE oauth_refresh_tokens
  ADD COLUMN IF NOT EXISTS granted_org_roles jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE oauth_device_authorizations
  ADD COLUMN IF NOT EXISTS granted_org_ids text[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE oauth_device_authorizations
  ADD COLUMN IF NOT EXISTS granted_org_roles jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Targeted-grant hints. When the agent already knows which Doco it
-- wants access to (and at what role), it passes these to POST
-- /oauth/device_authorization. The /device approve screen then shows
-- ONLY the target Doco with the requested role pre-filled, instead of
-- the full picker. Both nullable — when omitted, /device falls back
-- to the all-owned-Docos picker.
ALTER TABLE oauth_device_authorizations
  ADD COLUMN IF NOT EXISTS target_doco_handle text;
ALTER TABLE oauth_device_authorizations
  ADD COLUMN IF NOT EXISTS requested_role text
    CHECK (requested_role IS NULL OR requested_role IN ('reader','author','approver','owner'));

-- ──────────────────────────────────────────────────────────────────────────
-- v15 (2026-05-20): additive schema for the organization-ownership cutover.
--
-- v15 was the additive half: handle columns, org_id on docos,
-- doco_templates table, personal-org backfill. The destructive half
-- (NOT NULL relaxation on legacy columns) landed in the v16 series below.
--
-- Goals delivered here:
--   1. Every Organization has a `handle` (the public, kebab-case id).
--      Copies the legacy `slug` over for existing rows.
--   2. Every Doco has an `org_id` pointer to its owning Organization.
--      Backfilled from the legacy polymorphic `owner_id`.
--   3. Every Principal has a personal Organization with handle =
--      username. Minted lazily for existing Principals.
--   4. Docos get optional `allowed_neuron_types` and
--      `default_neuron_lifecycle` columns (for the upcoming doco-template
--      flow). NULL = no restriction.
--   5. `doco_templates` table for the v15+ create-from-template flow.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS handle text;
ALTER TABLE docos         ADD COLUMN IF NOT EXISTS org_id text;
ALTER TABLE docos         ADD COLUMN IF NOT EXISTS allowed_neuron_types text[];
ALTER TABLE docos         ADD COLUMN IF NOT EXISTS default_neuron_lifecycle text;

CREATE TABLE IF NOT EXISTS doco_templates (
  id           text PRIMARY KEY,
  handle       text NOT NULL UNIQUE,
  owner_id     text NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
  label        text NOT NULL,
  description  text NOT NULL,
  raw_yaml     text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS doco_templates_owner_idx ON doco_templates (owner_id);

-- ──────────────────────────────────────────────────────────────────────────
-- v16 (2026-05-20): relax NOT NULL on the legacy org/doco columns that v15
-- replaced (organizations.slug, organizations.name, docos.owner_id).
-- @doco/host still writes them for back-compat with old SELECTs,
-- but they're nullable so a future column drop is safe.
DO $v16_relax_columns$
BEGIN
  IF EXISTS (
    SELECT 1 FROM doco_meta WHERE key = 'v16_relax_legacy_columns' AND value = 'done'
  ) THEN
    RETURN;
  END IF;
  BEGIN
    ALTER TABLE organizations ALTER COLUMN slug DROP NOT NULL;
  EXCEPTION WHEN others THEN NULL;
  END;
  BEGIN
    ALTER TABLE organizations ALTER COLUMN name DROP NOT NULL;
  EXCEPTION WHEN others THEN NULL;
  END;
  BEGIN
    ALTER TABLE docos ALTER COLUMN owner_id DROP NOT NULL;
  EXCEPTION WHEN others THEN NULL;
  END;
  INSERT INTO doco_meta (key, value) VALUES ('v16_relax_legacy_columns', 'done')
    ON CONFLICT (key) DO UPDATE SET value = 'done';
END
$v16_relax_columns$;

DO $v15_backfill$
DECLARE
  princ record;
  new_org_id text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM doco_meta WHERE key = 'v15_org_backfill' AND value = 'done'
  ) THEN
    RETURN;
  END IF;

  -- 1) Copy slug → handle for existing orgs.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizations' AND column_name = 'slug'
  ) THEN
    UPDATE organizations SET handle = slug WHERE handle IS NULL OR handle = '';
  END IF;

  -- 2) Personal org for every Principal that doesn't already have one
  --    (handle = username). The Principal becomes its owner.
  FOR princ IN
    SELECT p.id, p.username
    FROM principals p
    WHERE p.username IS NOT NULL
      AND p.username <> ''
      AND NOT EXISTS (
        SELECT 1 FROM organizations o WHERE o.handle = p.username
      )
  LOOP
    new_org_id := 'organization_v15_' || replace(gen_random_uuid()::text, '-', '');
    -- slug + name are still NOT NULL on the legacy schema; populate
    -- them with the same handle so existing readers stay happy.
    INSERT INTO organizations (id, slug, name, handle, raw_yaml)
    VALUES (
      new_org_id,
      princ.username,
      princ.username,
      princ.username,
      jsonb_build_object('id', new_org_id, 'handle', princ.username,
                         'owner_id', princ.id)::text
    )
    ON CONFLICT (slug) DO NOTHING;

    INSERT INTO org_users (org_id, collaborator_id, role)
    SELECT id, princ.id, 'owner'
    FROM organizations WHERE handle = princ.username
    ON CONFLICT DO NOTHING;
    RAISE NOTICE 'v15 mint personal org: % owner=%', princ.username, princ.id;
  END LOOP;

  -- 3) Backfill docos.org_id from the legacy owner_id.
  UPDATE docos d
     SET org_id = d.owner_id
   WHERE d.org_id IS NULL AND d.owner_id LIKE 'organization_%';

  UPDATE docos d
     SET org_id = o.id
    FROM principals p
    JOIN organizations o ON o.handle = p.username
   WHERE d.org_id IS NULL
     AND d.owner_id = p.id
     AND d.owner_id LIKE 'principal_%';

  INSERT INTO doco_meta (key, value) VALUES ('v15_org_backfill', 'done')
    ON CONFLICT (key) DO UPDATE SET value = 'done';
END
$v15_backfill$;

-- ──────────────────────────────────────────────────────────────────────────
-- v17 (2026-05-20) lives in
-- packages/db/migrations/002_v17_handle_prefix_backfill.sql. Keep new
-- convergence work out of this baseline and add forward-only migration
-- files instead.
