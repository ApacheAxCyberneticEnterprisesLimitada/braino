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
--   - `edges` materializes cross-entity references for graph queries.
--   - `audit_events` is the structured history (decision_01KRKESCBTYG4005VMPKYNYR53).

-- Schema version. Tracked separately from app version so DB migrations
-- don't gate code releases. v1 = initial Phase 2 cut.
CREATE TABLE IF NOT EXISTS doco_meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);
INSERT INTO doco_meta (key, value) VALUES ('schema_version', '1') ON CONFLICT DO NOTHING;

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
    ALTER INDEX doco_members_principal_idx RENAME TO doco_users_principal_idx;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'scope_members') THEN
    ALTER TABLE scope_members RENAME TO scope_users;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'scope_members_principal_idx') THEN
    ALTER INDEX scope_members_principal_idx RENAME TO scope_users_principal_idx;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'org_members') THEN
    ALTER TABLE org_members RENAME TO org_users;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'org_members_principal_idx') THEN
    ALTER INDEX org_members_principal_idx RENAME TO org_users_principal_idx;
  END IF;

  -- Constraints don't auto-rename when tables rename.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_members_role_check') THEN
    ALTER TABLE org_users RENAME CONSTRAINT org_members_role_check TO org_users_role_check;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'doco_members_role_check') THEN
    ALTER TABLE doco_users RENAME CONSTRAINT doco_members_role_check TO doco_users_role_check;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scope_members_role_check') THEN
    ALTER TABLE scope_users RENAME CONSTRAINT scope_members_role_check TO scope_users_role_check;
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

-- Identity layer.

CREATE TABLE IF NOT EXISTS principals (
  id              text PRIMARY KEY,
  username        text NOT NULL UNIQUE,
  type            text NOT NULL CHECK (type IN ('human', 'agent')),
  email           text,
  github_login    text,
  avatar_url      text,
  owner_id        text REFERENCES principals(id) ON DELETE SET NULL,
  raw_yaml        text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deactivated_at  timestamptz
);

-- v10 username-only principals: users do not carry standalone display
-- names. The database stores usernames plus identity metadata; any old
-- `display_name` column and embedded raw_yaml key are removed in place.
DO $v10_principal_username_only$
DECLARE
  principal_row record;
BEGIN
  FOR principal_row IN
    SELECT id, raw_yaml FROM principals WHERE raw_yaml LIKE '%display_name%'
  LOOP
    BEGIN
      UPDATE principals
         SET raw_yaml = (principal_row.raw_yaml::jsonb - 'display_name')::text
       WHERE id = principal_row.id;
    EXCEPTION WHEN others THEN
      -- Legacy host files may have stored YAML text here. The column drop
      -- still removes the indexed display name; future principal writes
      -- strip the JSON key before storing raw_yaml.
      NULL;
    END;
  END LOOP;
END
$v10_principal_username_only$;
ALTER TABLE principals DROP COLUMN IF EXISTS display_name;

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
  principal_id  text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, principal_id)
);
CREATE INDEX IF NOT EXISTS org_users_principal_idx ON org_users (principal_id, role);

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
-- flagged it; never fully removed). Idempotent — no-op on fresh DBs.
ALTER TABLE intents            DROP COLUMN IF EXISTS revision;
ALTER TABLE decisions          DROP COLUMN IF EXISTS revision;
ALTER TABLE rules              DROP COLUMN IF EXISTS revision;
ALTER TABLE actions            DROP COLUMN IF EXISTS revision;
ALTER TABLE evals              DROP COLUMN IF EXISTS revision;
ALTER TABLE scopes             DROP COLUMN IF EXISTS revision;
ALTER TABLE ideas              DROP COLUMN IF EXISTS revision;
ALTER TABLE reference_entities DROP COLUMN IF EXISTS revision;

-- Deprecation (2026-05-16): the `reasoning` node type was removed.
-- Drop the legacy table and purge any dangling edges / embeddings /
-- audit rows so existing databases converge to the new shape on boot.
-- Idempotent — no-op on fresh DBs.
DROP TABLE IF EXISTS reasoning CASCADE;
DELETE FROM edges         WHERE from_id LIKE 'reasoning\_%' ESCAPE '\' OR to_id LIKE 'reasoning\_%' ESCAPE '\';
DELETE FROM embeddings    WHERE entity_id LIKE 'reasoning\_%' ESCAPE '\';
DELETE FROM audit_events  WHERE entity_id LIKE 'reasoning\_%' ESCAPE '\';

-- v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG): the framework drops the
-- `Rule.kind="authoring"` marker in favor of `Scope.gated_by` (an edge
-- from the Scope to each Rule that gates captures into it). The DDL
-- here is unchanged — both `gated_by` and `kind` live in raw_yaml and
-- don't need their own columns. The actual YAML rewrite (parse each
-- Rule's raw_yaml; if `kind: authoring`, copy the rule's id into each
-- listed scope's `gated_by` and flip `kind` to `tagged`) runs as a
-- TypeScript one-shot at server startup (runV7Migration in
-- @doco/web/app/lib/migrations/v7.server.ts) gated on
-- schema_version < '2'. Bumping schema_version is what the TS
-- migration writes back after successful completion.

-- ──────────────────────────────────────────────────────────────────────────
-- Multi-level access (decision_01KS0JBJ5X0AZ4XJJFKEWE1R62).
--
-- Four roles (owner / approver / author / reader) granted at three levels
-- (org / doco / scope). Effective role = max across levels (highest-wins
-- additive composition). Scope-only grant implies doco-reader visibility.
-- Author-role writes default to lifecycle `proposed`; only approver+ can
-- transition. #global constitution edits require doco-level owner.

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

-- Per-doco user grants. Replaces the binary "any SessionToken bound to
-- this Doco = full admin" gate that doco-access.server.ts used pre-cutover.
-- Backfill writes one row per (principal, bound_doco_id) discovered in
-- the session-token blob with role='owner' (see v8 DO block below).
CREATE TABLE IF NOT EXISTS doco_users (
  doco_id       text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  principal_id  text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner', 'approver', 'author', 'reader')),
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doco_id, principal_id)
);
CREATE INDEX IF NOT EXISTS doco_users_principal_idx ON doco_users (principal_id, role);

-- Per-scope user grants. Layers on top of doco_users. A scope-only grant
-- (no doco_users row for this principal+doco) implies doco-reader
-- visibility per decision_01KS0JBJ5X0AZ4XJJFKEWE1R62.
CREATE TABLE IF NOT EXISTS scope_users (
  scope_id      text NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  principal_id  text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner', 'approver', 'author', 'reader')),
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, principal_id)
);
CREATE INDEX IF NOT EXISTS scope_users_principal_idx ON scope_users (principal_id, role);

-- ──────────────────────────────────────────────────────────────────────────
-- Token store (session tokens + CLI authorizations). Alpha keeps this as a
-- host-scoped JSON blob; move to one-row-per-token tables once the surface
-- stabilizes.
CREATE TABLE IF NOT EXISTS tokens_blob (
  key        text PRIMARY KEY,
  blob       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- v8 backfill (decision_01KS0JBJ5X0AZ4XJJFKEWE1R62): every active SessionToken
-- bound to a Doco grandfathers its principal into doco_users with role='owner'
-- so the cutover loses no existing user access. Runs once per host
-- (gated on doco_meta.v8_doco_users_backfill, with a legacy compat check
-- for the pre-v9 'v8_doco_members_backfill' key); subsequent invite
-- redemptions write doco_users directly. ON CONFLICT DO NOTHING so manual
-- role changes made after the first run are not stomped.
DO $v8_backfill$
BEGIN
  IF EXISTS (
    SELECT 1 FROM doco_meta
    WHERE key IN ('v8_doco_users_backfill', 'v8_doco_members_backfill')
      AND value = 'done'
  ) THEN
    RETURN;
  END IF;

  INSERT INTO doco_users (doco_id, principal_id, role)
  SELECT DISTINCT
    (tok->>'bound_doco_id'),
    (tok->>'principal_id'),
    'owner'
  FROM tokens_blob
  CROSS JOIN LATERAL jsonb_array_elements(blob->'tokens') AS tok
  WHERE tok->>'kind' = 'session'
    AND tok->>'bound_doco_id' IS NOT NULL
    AND tok->>'principal_id' IS NOT NULL
    AND COALESCE((tok->>'revoked')::boolean, false) = false
    AND EXISTS (SELECT 1 FROM docos      WHERE id = tok->>'bound_doco_id')
    AND EXISTS (SELECT 1 FROM principals WHERE id = tok->>'principal_id')
  ON CONFLICT (doco_id, principal_id) DO NOTHING;

  INSERT INTO doco_meta (key, value)
  VALUES ('v8_doco_users_backfill', 'done')
  ON CONFLICT (key) DO UPDATE SET value = 'done';
END
$v8_backfill$;
