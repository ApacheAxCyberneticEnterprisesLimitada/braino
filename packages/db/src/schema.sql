-- Doco Postgres schema (decision_01KRKEVEE3RQGPWHAPMZ0MS9G9).
--
-- Source-of-truth + read-side index in one database per host.
--
-- Single-database, multi-tenant: every entity carries its `doco_id`
-- which scopes it to the owning Doco. Hosts can hold thousands of
-- Doco instances in one database.
--
-- Schema rules:
--   - `nodes` stores every graph entity, discriminated by `node_type`.
--   - Policies, users, workspaces, and Docos live in dedicated tables.
--   - `edges` stores relationships between nodes for graph queries.
--   - `audit_events` stores structured mutation history.
--
-- Vocabulary:
--   nodes   — graph entities (10 types: intent/idea/rule/decision/action/
--               log/eval/reference/state/principal)
--   policies — Doco-level authoring metadata (one `policies` table; each
--               row's `kind` is suggestion / deterministic / probabilistic)
--   edges   — relationships between nodes
--   users      — human OAuth identities, separate from principals
--                (which are role-personas linked by graph edges).

-- ──────────────────────────────────────────────────────────────────────────
-- Heal: the "organization" container was renamed to "workspace" — table,
-- columns, and the `organization_<ulid>` id prefix. schema.sql is additive and
-- re-applied on every boot, so a database provisioned under the old names is
-- migrated in place here, BEFORE the CREATE TABLEs below would otherwise mint a
-- second, empty `workspaces` table. Guarded on the old `organizations` table
-- still existing, so it runs once per database and is a no-op on fresh installs
-- and on every boot thereafter. The org-CHART perspective (perspective_org_tree)
-- is a different concept and is deliberately untouched.
DO $$
DECLARE
  fk   record;
  tbl  text;
BEGIN
  -- Serialize across concurrent boots: only one instance runs the rename, the
  -- rest wait and then see `organizations` already gone and return. The lock is
  -- transaction-scoped (this DO block), so it releases as soon as we finish.
  PERFORM pg_advisory_xact_lock(704932185);

  IF NOT EXISTS (
    SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'organizations'
  ) THEN
    RETURN;
  END IF;

  -- 1. Rename the tables.
  ALTER TABLE organizations RENAME TO workspaces;
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'org_users') THEN
    ALTER TABLE org_users RENAME TO workspace_users;
  END IF;

  -- 2. Rename org-prefixed columns to their workspace names.
  IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'workspace_users' AND column_name = 'org_id') THEN
    ALTER TABLE workspace_users RENAME COLUMN org_id TO workspace_id;
  END IF;
  IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'docos' AND column_name = 'org_id') THEN
    ALTER TABLE docos RENAME COLUMN org_id TO workspace_id;
  END IF;
  IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'audit_events' AND column_name = 'org_id') THEN
    ALTER TABLE audit_events RENAME COLUMN org_id TO workspace_id;
  END IF;
  IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'chat_conversations' AND column_name = 'attached_org_handles') THEN
    ALTER TABLE chat_conversations RENAME COLUMN attached_org_handles TO attached_workspace_handles;
  END IF;
  FOREACH tbl IN ARRAY ARRAY['oauth_authorization_codes','oauth_access_tokens','oauth_refresh_tokens','oauth_device_authorizations'] LOOP
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = tbl AND column_name = 'granted_org_ids') THEN
      EXECUTE format('ALTER TABLE %I RENAME COLUMN granted_org_ids TO granted_workspace_ids', tbl);
    END IF;
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = tbl AND column_name = 'granted_org_roles') THEN
      EXECUTE format('ALTER TABLE %I RENAME COLUMN granted_org_roles TO granted_workspace_roles', tbl);
    END IF;
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = tbl AND column_name = 'granted_org_write_types') THEN
      EXECUTE format('ALTER TABLE %I RENAME COLUMN granted_org_write_types TO granted_workspace_write_types', tbl);
    END IF;
  END LOOP;

  -- 3. Drop FKs that reference the renamed table, rewrite organization_<ulid>
  --    ids to workspace_<ulid>, then re-add the FKs under workspace names.
  FOR fk IN
    SELECT conrelid::regclass AS rel, conname
      FROM pg_constraint
     WHERE confrelid = 'workspaces'::regclass AND contype = 'f'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.rel, fk.conname);
  END LOOP;

  UPDATE workspaces      SET id           = replace(id, 'organization_', 'workspace_')           WHERE id LIKE 'organization_%';
  UPDATE workspace_users SET workspace_id = replace(workspace_id, 'organization_', 'workspace_') WHERE workspace_id LIKE 'organization_%';
  UPDATE docos           SET workspace_id = replace(workspace_id, 'organization_', 'workspace_') WHERE workspace_id LIKE 'organization_%';
  UPDATE docos           SET owner_id     = replace(owner_id, 'organization_', 'workspace_')     WHERE owner_id LIKE 'organization_%';
  UPDATE audit_events    SET workspace_id = replace(workspace_id, 'organization_', 'workspace_') WHERE workspace_id LIKE 'organization_%';
  UPDATE audit_events    SET entity_id    = replace(entity_id, 'organization_', 'workspace_')    WHERE entity_id LIKE 'organization_%';

  ALTER TABLE workspace_users ADD CONSTRAINT workspace_users_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  ALTER TABLE docos ADD CONSTRAINT docos_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  ALTER TABLE audit_events ADD CONSTRAINT audit_events_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

  -- 4. Rewrite organization_<ulid> ids embedded in OAuth grant scopes.
  FOREACH tbl IN ARRAY ARRAY['oauth_authorization_codes','oauth_access_tokens','oauth_refresh_tokens','oauth_device_authorizations'] LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = tbl
    );
    EXECUTE format($q$
      UPDATE %I SET granted_workspace_ids =
        string_to_array(replace(array_to_string(granted_workspace_ids, ','), 'organization_', 'workspace_'), ',')
       WHERE array_to_string(granted_workspace_ids, ',') LIKE '%%organization_%%'
    $q$, tbl);
    EXECUTE format($q$
      UPDATE %I SET granted_workspace_roles =
        replace(granted_workspace_roles::text, 'organization_', 'workspace_')::jsonb
       WHERE granted_workspace_roles::text LIKE '%%organization_%%'
    $q$, tbl);
    EXECUTE format($q$
      UPDATE %I SET granted_workspace_write_types =
        replace(granted_workspace_write_types::text, 'organization_', 'workspace_')::jsonb
       WHERE granted_workspace_write_types::text LIKE '%%organization_%%'
    $q$, tbl);
  END LOOP;

  -- Invites (opaque jsonb blob) may embed organization_<ulid> ids + grant maps.
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'tokens_blob') THEN
    UPDATE tokens_blob SET blob = replace(blob::text, 'organization_', 'workspace_')::jsonb
     WHERE blob::text LIKE '%organization_%';
  END IF;

  -- Group-chat connections: target_level 'org' -> 'workspace', the workspace
  -- id they carry, and the CHECK constraint.
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'group_chat_channel_connections') THEN
    ALTER TABLE group_chat_channel_connections DROP CONSTRAINT IF EXISTS group_chat_channel_connections_target_level_check;
    UPDATE group_chat_channel_connections SET target_level = 'workspace' WHERE target_level = 'org';
    UPDATE group_chat_channel_connections SET target_id = replace(target_id, 'organization_', 'workspace_')
     WHERE target_id LIKE 'organization_%';
    ALTER TABLE group_chat_channel_connections
      ADD CONSTRAINT group_chat_channel_connections_target_level_check CHECK (target_level IN ('workspace','doco'));
  END IF;

  -- 5. Drop now-stale org-named indexes; CREATE INDEX below re-mints them.
  DROP INDEX IF EXISTS org_users_user_idx;
  DROP INDEX IF EXISTS audit_events_org_idx;
END $$;

-- Host config (singleton row at id='host').
CREATE TABLE IF NOT EXISTS hosts (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  visibility  text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Bootstrap host row. The seed below keeps /home from 500'ing on a
-- fresh install (every layout reads host config). Idempotent — the
-- ON CONFLICT keeps existing host configs untouched.
INSERT INTO hosts (id, name, visibility, data)
VALUES ('host', 'Doco', 'public', '{"id":"host","name":"Doco","visibility":"public"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- Identity layer.
--
-- Two distinct concerns, split into two tables:
--   `users`      — OAuth identity for humans. Authored nodes via
--                  `created_by` / `updated_by`. Members of workspaces/docos.
--                  OAuth clients/tokens have names on the token rows;
--                  they are not represented as user rows.
--   `principals` — role-personas (the "actor" in a documented business
--                  process). Linked from work through first-class edges.

CREATE TABLE IF NOT EXISTS users (
  id              text PRIMARY KEY,            -- user_<ulid>
  github_id       text,                        -- GitHub numeric id (immutable)
  github_login    text,                        -- current GitHub login (mutable)
  email           text,
  avatar_url      text,
  data            jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deactivated_at  timestamptz
);
CREATE INDEX IF NOT EXISTS users_github_login_idx ON users (github_login);


CREATE TABLE IF NOT EXISTS workspaces (
  id          text PRIMARY KEY,
  handle      text NOT NULL UNIQUE,
  name        text NOT NULL,
  -- Free-form governing charter for the workspace — the standing "how work is
  -- done here" text shared with every agent granted access to the workspace at
  -- bootstrap, and shown on the workspace home page.
  constitution text NOT NULL DEFAULT '',
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Heal: workspaces seeded with the pre-rename default constitution still carry
-- the old "in this organization" wording. The default now reads "in this
-- workspace", so rewrite the seeded phrase in any stored constitution. Targeted
-- + idempotent (only the exact phrase), so it leaves hand-written prose alone.
UPDATE workspaces
   SET constitution = replace(constitution, 'every Doco in this organization', 'every Doco in this workspace')
 WHERE constitution LIKE '%every Doco in this organization%';

-- Workspace users (per-workspace role grants).
CREATE TABLE IF NOT EXISTS workspace_users (
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner', 'writer', 'reader')),
  -- Per-type write grants. '*' = write every type; owners ignore this and
  -- write everything.
  write_types   text[] NOT NULL DEFAULT ARRAY[]::text[],
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS workspace_users_user_idx ON workspace_users (user_id);

-- Account-level access grants. An account grant from grantor to grantee gives
-- the grantee `role` (+ optional per-type write_types) on every workspace the
-- grantor owns and, via the workspace-to-Doco cascade in the access engine, every
-- Doco under those workspaces. Live grant: workspaces the grantor creates later are
-- covered automatically.
CREATE TABLE IF NOT EXISTS account_grants (
  grantor_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grantee_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('owner', 'writer', 'reader')),
  write_types     text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (grantor_user_id, grantee_user_id)
);
CREATE INDEX IF NOT EXISTS account_grants_grantee_idx
  ON account_grants (grantee_user_id);

-- Every Doco has a single public `handle`. It lives in the same flat
-- namespace as top-level host routes. The internal ULID `id` stays as
-- the FK target for entity tables; `handle` is what URLs and public API
-- calls use.
CREATE TABLE IF NOT EXISTS docos (
  id              text PRIMARY KEY,
  handle          text NOT NULL UNIQUE,
  owner_id        text NOT NULL,    -- workspace_<ulid>
  workspace_id    text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  visibility      text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  default_node_lifecycle text,
  -- Free-form sentence the project owner writes (or the creation template
  -- seeds) to tell agents what this Doco is for. Surfaced at the top of
  -- each Doco's policy set in the agent-bootstrap manifest, and under
  -- the title on the Doco home page.
  goal            text NOT NULL DEFAULT '',
  data            jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- Self-heal: the Doco-level `allowed_node_types` allowlist was seeded at
-- creation but never read by any capture-time check — the lone template that
-- set it (`global`) pointed at the removed `guidance_policy` /
-- `node_authoring_policy` types. Idempotent — drops it where present, no-op
-- on a fresh DB.
ALTER TABLE docos DROP COLUMN IF EXISTS allowed_node_types;

-- Per-Doco policies. Every policy is an authoring policy; the standalone
-- `kind` classifies it ('suggestion' | 'deterministic' | 'probabilistic') and
-- is mirrored to a column for filtering. The full structured record
-- (predicate, on_violation, fires_when_node_lifecycle, …) lives in `data`.

CREATE TABLE IF NOT EXISTS policies (
  id          text PRIMARY KEY,
  doco_id     text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  -- 'suggestion' | 'deterministic' | 'probabilistic'.
  kind        text,
  -- Policies only ever occupy two stages: 'active' or 'retired'.
  lifecycle   text NOT NULL DEFAULT 'active',
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
CREATE INDEX IF NOT EXISTS policies_doco_idx
  ON policies (doco_id, created_at DESC);
CREATE INDEX IF NOT EXISTS policies_kind_idx
  ON policies (doco_id, kind);
CREATE INDEX IF NOT EXISTS policies_lifecycle_idx
  ON policies (doco_id, lifecycle);

-- Policies never carried a rationale that any template populated, so the
-- per-policy `body_md` column was retired. schema.sql is re-applied on every
-- boot, so this strips the column from databases provisioned under the old
-- shape and is a no-op on fresh installs and on every boot thereafter.
ALTER TABLE policies DROP COLUMN IF EXISTS body_md;

-- ── Unified node table ───────────────────────────────────────────────────
-- One row per graph node of any type, discriminated by `node_type`.
--
-- "Wide" by design: per-type promoted SCALAR columns are preserved here as
-- real nullable columns so reads keep their existing column names. Node-to-node
-- relationships live only in `edges`. `proposer_id` points at `users(id)` (the
-- OAuth identity that proposed the idea, not a graph node).
--
-- Policies are deliberately NOT folded in here: the `policies` table stays
-- its own table (governance config, not graph knowledge). It shares the
-- node_versions spine, so any rebuild-from-spine MUST filter entity_type to
-- the node types below.
CREATE TABLE IF NOT EXISTS nodes (
  id             text PRIMARY KEY,            -- <node_type>_<ulid>
  doco_id        text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  node_type      text NOT NULL,              -- intent|idea|rule|decision|action|log|eval|reference|state|principal
  -- Lifecycle is mandatory; canonical stages: drafting|queued|active|retired.
  lifecycle      text NOT NULL DEFAULT 'active',
  prose          text NOT NULL DEFAULT '',   -- unified type-named column for the 9 prose node types; empty string for principals
  name           text,                       -- principal display label (NULL for the others)
  body_md        text,                       -- principal prose description (NULL for the others)
  role_principal boolean NOT NULL DEFAULT false,
  proposer_id               text CONSTRAINT nodes_proposer_fk               REFERENCES users(id) ON DELETE SET NULL,             -- idea → users(id) (OAuth identity)
  -- Promoted scalar columns. Slim-down contract phase: the action/log/rule
  -- scalars (verb / performed_at / happened_at / severity / phase /
  -- on_violation) moved into `attributes` and are dropped below; only `kind`
  -- and the reference columns remain promoted.
  kind         text,                          -- eval, state
  ref_type     text,                          -- reference
  locator      text,                          -- reference
  citation     text,                          -- reference
  title        text,                          -- reference
  data         jsonb NOT NULL,
  -- Node-shape slim-down (expand phase): the unified per-node attributes bag
  -- that will replace every per-type promoted column (except `kind`) and the
  -- catch-all `data` jsonb. Populated on write and by the backfill below;
  -- nothing reads it yet, so this stays non-destructive.
  attributes   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text
);
CREATE INDEX IF NOT EXISTS nodes_doco_type_idx  ON nodes (doco_id, node_type, created_at DESC);
CREATE INDEX IF NOT EXISTS nodes_doco_life_idx  ON nodes (doco_id, lifecycle);

-- Self-heal: `modality` was a promoted Rule column that capture always wrote
-- as the constant "must" and no reader ever consulted (enforcement modality
-- lives in Policy records, not Rule nodes). Drop it. Idempotent — removed
-- where present, a no-op on fresh installs (never created above).
ALTER TABLE nodes DROP COLUMN IF EXISTS modality;

-- Node-shape slim-down. Add the unified `attributes` bag and backfill it from
-- `data` + the retained promoted columns (defensive: the writer already fills
-- it on every write, this only touches rows still on the empty default).
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS attributes jsonb NOT NULL DEFAULT '{}'::jsonb;
UPDATE nodes
   SET attributes = jsonb_strip_nulls(
         (COALESCE(data, '{}'::jsonb)
            -- identity / audit / lifecycle live in real columns
            - 'id' - 'doco_id' - 'node_type' - 'lifecycle'
            - 'created_at' - 'created_by' - 'updated_at' - 'updated_by'
            -- prose + its historical aliases live in `prose`
            - 'prose' - 'summary' - 'description'
            -- principal label/body (kept as columns this phase) + dropped flag
            - 'name' - 'body_md' - 'role_principal'
            -- columns we keep promoted
            - 'kind' - 'proposer_id'
            -- the type-named prose field, duplicated into data on old writes
            - 'intent' - 'idea' - 'rule' - 'decision' - 'action'
            - 'log' - 'eval' - 'reference' - 'state')
         || jsonb_build_object(
              'ref_type', ref_type, 'locator', locator, 'citation', citation, 'title', title))
 WHERE attributes = '{}'::jsonb;

-- Contract phase: the action/log/rule scalar columns now live in `attributes`.
-- Fold any straggler values in, then DROP the columns. Guarded on the `verb`
-- column so a fresh install (never created them) and an already-migrated DB
-- both skip — idempotent across every prod boot.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'nodes' AND column_name = 'verb'
  ) THEN
    UPDATE nodes
       SET attributes = attributes || jsonb_strip_nulls(jsonb_build_object(
             'verb', verb, 'performed_at', performed_at, 'happened_at', happened_at,
             'severity', severity, 'phase', phase, 'on_violation', on_violation));
    ALTER TABLE nodes
      DROP COLUMN IF EXISTS verb,
      DROP COLUMN IF EXISTS performed_at,
      DROP COLUMN IF EXISTS happened_at,
      DROP COLUMN IF EXISTS severity,
      DROP COLUMN IF EXISTS phase,
      DROP COLUMN IF EXISTS on_violation;
  END IF;
END $$;

-- Audit events: one row per mutation.

CREATE TABLE IF NOT EXISTS audit_events (
  event_id      text PRIMARY KEY,
  at            timestamptz NOT NULL,
  by_user       text,
  doco_id       text REFERENCES docos(id) ON DELETE CASCADE,
  workspace_id  text REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type   text NOT NULL,
  entity_id     text NOT NULL,
  op            text NOT NULL CHECK (op IN ('entity.create', 'entity.update', 'lifecycle.transition', 'edge.add')),
  before_json   jsonb,
  after_json    jsonb,
  reason        text
);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events (entity_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_events_doco_idx ON audit_events (doco_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_events_op_idx ON audit_events (doco_id, op, at DESC);
CREATE INDEX IF NOT EXISTS audit_events_user_idx ON audit_events (by_user, at DESC);
CREATE INDEX IF NOT EXISTS audit_events_workspace_idx ON audit_events (workspace_id, at DESC);

-- ──────────────────────────────────────────────────────────────────────────
-- Append-only history. The commit log + immutable version snapshots are the
-- source of truth; `nodes` and `edges` are the current-state projection.
-- Nothing is hard-deleted — removal is a `retire` version.

-- Commit log — one row per atomic changeset (Git's commit). Carries
-- who/when/WHY. tx_id is a global monotonic sequence enabling whole-graph
-- "as-of" reads. Append-only; never updated or deleted.
CREATE TABLE IF NOT EXISTS changesets (
  tx_id        bigserial PRIMARY KEY,
  doco_id      text REFERENCES docos(id) ON DELETE CASCADE,
  actor        text,                          -- user_<ulid>
  source       text NOT NULL DEFAULT 'api'
                 CHECK (source IN ('api','mcp','ui','slack','import','reset','system')),
  reason       text,                          -- the rich "why"
  metadata     jsonb,
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS changesets_doco_idx ON changesets (doco_id, tx_id DESC);

-- Immutable version snapshots — one row per (entity, version). payload is
-- the FULL state of the node/edge at that version, so "how it was" is an
-- O(1) read, never a replay (Git's blob/tree). Append-only.
CREATE TABLE IF NOT EXISTS node_versions (
  entity_id    text NOT NULL,
  entity_type  text NOT NULL,                 -- node type (decision, intent, …)
  version      int  NOT NULL,
  op           text NOT NULL CHECK (op IN ('create','update','retire')),
  payload      jsonb NOT NULL,
  tx_id        bigint NOT NULL REFERENCES changesets(tx_id) ON DELETE CASCADE,
  actor        text,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  prev_hash    text,                          -- Merkle hash chain (see verifyHistory in history.ts)
  this_hash    text,
  PRIMARY KEY (entity_id, version)
);
CREATE INDEX IF NOT EXISTS node_versions_tx_idx   ON node_versions (tx_id);
CREATE INDEX IF NOT EXISTS node_versions_asof_idx ON node_versions (entity_id, tx_id);

CREATE TABLE IF NOT EXISTS edge_versions (
  entity_id    text NOT NULL,                 -- edge_<ulid>
  entity_type  text NOT NULL DEFAULT 'edge',
  version      int  NOT NULL,
  op           text NOT NULL CHECK (op IN ('create','update','retire')),
  payload      jsonb NOT NULL,
  tx_id        bigint NOT NULL REFERENCES changesets(tx_id) ON DELETE CASCADE,
  actor        text,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  prev_hash    text,
  this_hash    text,
  PRIMARY KEY (entity_id, version)
);
CREATE INDEX IF NOT EXISTS edge_versions_tx_idx   ON edge_versions (tx_id);
CREATE INDEX IF NOT EXISTS edge_versions_asof_idx ON edge_versions (entity_id, tx_id);

-- Indexing layer tables. These hold derived data the read side consumes:
-- graph edges, vector embeddings, denormalized rule targets, and full-text
-- search rows. Postgres is both source of truth and read-side index.

-- Graph edges. Each edge is its own row with a surrogate id (edge_<ulid>),
-- lifecycle, and provenance — a peer of nodes, not a derived cache.
-- Mutated by edge CRUD via commit(); the indexer never wipes/rebuilds this
-- table. Removal is lifecycle='retired', never DELETE.
CREATE TABLE IF NOT EXISTS edges (
  id              text PRIMARY KEY,           -- edge_<ulid>
  doco_id         text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  edge_type       text NOT NULL,
  from_id         text NOT NULL CONSTRAINT edges_from_fk REFERENCES nodes(id) DEFERRABLE INITIALLY DEFERRED,
  from_node_type  text NOT NULL,
  to_id           text NOT NULL CONSTRAINT edges_to_fk   REFERENCES nodes(id) DEFERRABLE INITIALLY DEFERRED,
  to_node_type    text NOT NULL,
  props           jsonb,
  lifecycle       text NOT NULL DEFAULT 'active',
  origin          text NOT NULL DEFAULT 'authored'
                    CHECK (origin IN ('authored')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text,                       -- user_<ulid>
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      text,
  retired_at      timestamptz
);
-- At most one LIVE edge per (doco, from, to, type, role); retired duplicates
-- ok. Canonical edge families may carry multiple roles between the same nodes
-- (e.g. actor + owner attribution), so role metadata is part of the live
-- uniqueness identity.
CREATE UNIQUE INDEX IF NOT EXISTS edges_live_uniq
  ON edges (
    doco_id,
    from_id,
    to_id,
    edge_type,
    COALESCE(props->>'role', '')
  ) WHERE lifecycle <> 'retired';
CREATE INDEX IF NOT EXISTS edges_doco_idx           ON edges (doco_id);
CREATE INDEX IF NOT EXISTS edges_doco_type_from_idx ON edges (doco_id, edge_type, from_id);
CREATE INDEX IF NOT EXISTS edges_doco_type_to_idx   ON edges (doco_id, edge_type, to_id);
CREATE INDEX IF NOT EXISTS edges_from_idx           ON edges (from_id);
CREATE INDEX IF NOT EXISTS edges_to_idx             ON edges (to_id);
CREATE INDEX IF NOT EXISTS edges_lifecycle_idx      ON edges (doco_id, lifecycle);

-- Vector embeddings. One row per entity. Storage is bytea
-- (Float32Array bytes, little-endian). pgvector + ivfflat/hnsw is an
-- additive optimization; the current bytea shape keeps indexing simple.
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

-- Full-text search. Only nodes are indexed (entity_fts_nodes): the indexer
-- populates summary + body, and Slack search — the lone reader — queries the
-- generated `search_tsv` tsvector (English stemming, weighted A=summary,
-- B=body) through a GIN index for `@@` queries.

CREATE TABLE IF NOT EXISTS entity_fts_nodes (
  entity_id    text PRIMARY KEY,
  doco_id      text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  node_type  text NOT NULL,
  summary      text,
  body         text,
  search_tsv   tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(summary, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'B')
  ) STORED
);
CREATE INDEX IF NOT EXISTS entity_fts_nodes_doco_idx ON entity_fts_nodes (doco_id);
CREATE INDEX IF NOT EXISTS entity_fts_nodes_tsv_idx  ON entity_fts_nodes USING gin (search_tsv);

-- ──────────────────────────────────────────────────────────────────────────
-- Multi-level access (decision_01KS0JBJ5X0AZ4XJJFKEWE1R62).
--
-- Three roles (owner / writer / reader) granted at two levels
-- (workspace / doco). Effective role = max across levels (highest-wins
-- additive composition). Writers may add, edit, retire, and transition
-- the lifecycle of any node or edge; what they may or may not do
-- is governed by the Doco's own policies, not a built-in role ladder.
-- Owners additionally administer the Doco (users, tokens, policies).

-- Per-doco user grants. Invite redemption and owner/admin surfaces write
-- these rows directly; OAuth tokens authenticate callers but do not store
-- membership.
CREATE TABLE IF NOT EXISTS doco_users (
  doco_id       text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner', 'writer', 'reader')),
  -- Per-type write grants. '*' = write every type; owners ignore this and
  -- write everything.
  write_types   text[] NOT NULL DEFAULT ARRAY[]::text[],
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doco_id, user_id)
);
CREATE INDEX IF NOT EXISTS doco_users_user_idx ON doco_users (user_id);

-- ──────────────────────────────────────────────────────────────────────────
-- Invite store backing blob.
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
  user_id               text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri          text NOT NULL,
  token_name            text,
  code_challenge        text NOT NULL,
  code_challenge_method text NOT NULL DEFAULT 'S256' CHECK (code_challenge_method = 'S256'),
  granted_doco_ids      text[] NOT NULL,
  -- Per-Doco role scope-down. Map of doco_id → DocoRole capping the
  -- token's effective role on that Doco. The user can lower the role
  -- below what they themselves hold (give the agent "reader" on a Doco
  -- where they're owner) but never raise it. Missing entries mean
  -- "inherit the principal's actual role" — i.e. no scope-down.
  granted_doco_roles    jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Per-type write scope-down, keyed by doco_id to a list of writable-type
  -- tokens ('*' = all). Parallels granted_doco_roles.
  granted_doco_write_types jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Workspace-level grants. When the user approves access to a workspace, every
  -- Doco owned by that workspace becomes reachable through this token —
  -- including Docos created under the workspace after the token was minted
  -- ("live" grant, not a snapshot). `granted_workspace_roles[workspace_id]` caps
  -- the effective role on Docos under that workspace, same semantics as
  -- granted_doco_roles.
  granted_workspace_ids       text[] NOT NULL DEFAULT ARRAY[]::text[],
  granted_workspace_roles     jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_workspace_write_types jsonb NOT NULL DEFAULT '{}'::jsonb,
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
  user_id           text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_name        text,
  granted_doco_ids  text[] NOT NULL,
  granted_doco_roles jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_doco_write_types jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_workspace_ids   text[] NOT NULL DEFAULT ARRAY[]::text[],
  granted_workspace_roles jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_workspace_write_types jsonb NOT NULL DEFAULT '{}'::jsonb,
  scope             text,
  expires_at        timestamptz NOT NULL,
  revoked           boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_access_tokens_user_idx ON oauth_access_tokens (user_id);
CREATE INDEX IF NOT EXISTS oauth_access_tokens_expires_idx
  ON oauth_access_tokens (expires_at);

-- Refresh tokens (long-lived; 60-day default). Used by the runtime
-- when the access token expires; one round-trip to /oauth/token with
-- grant_type=refresh_token mints a fresh access token without
-- re-prompting the user.
--
-- Non-rotating: a refresh reissues only the access token and keeps the
-- same refresh token (expiry slid forward), so DOCO_REFRESH can be pinned
-- anywhere — a repo .env, cloud env vars, CI secrets — without going stale.
-- Revocation (from /tokens) is how a token is cut off.
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token             text PRIMARY KEY,
  client_id         text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id           text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_name        text,
  granted_doco_ids  text[] NOT NULL,
  granted_doco_roles jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_doco_write_types jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_workspace_ids   text[] NOT NULL DEFAULT ARRAY[]::text[],
  granted_workspace_roles jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_workspace_write_types jsonb NOT NULL DEFAULT '{}'::jsonb,
  scope             text,
  expires_at        timestamptz NOT NULL,
  revoked           boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_user_idx ON oauth_refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_expires_idx
  ON oauth_refresh_tokens (expires_at);
-- Self-heal: refresh tokens are always non-rotating, so the rotation
-- columns are dead. Idempotent — drops them where present, no-op on fresh.
ALTER TABLE oauth_refresh_tokens DROP COLUMN IF EXISTS non_rotating;
ALTER TABLE oauth_refresh_tokens DROP COLUMN IF EXISTS superseded_by;

-- Device Authorization Grant (RFC 8628). Designed for agents that
-- cannot drive a localhost-redirect OAuth flow (no port-binding,
-- no browser of their own): the agent calls
-- POST /oauth/device_authorization, displays the short `user_code`
-- to the human, then polls /oauth/token until the human approves
-- in their browser at GET /device.
--
-- `status` transitions: pending → approved (user_id +
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
  user_id             text REFERENCES users(id) ON DELETE CASCADE,
  token_name          text,
  granted_doco_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  granted_doco_roles jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_doco_write_types jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_workspace_ids  text[] NOT NULL DEFAULT ARRAY[]::text[],
  granted_workspace_roles jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_workspace_write_types jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_doco_handle text,
  requested_role text CHECK (requested_role IS NULL OR requested_role IN ('reader','writer','owner')),
  expires_at       timestamptz NOT NULL,
  last_polled_at   timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_device_authorizations_user_code_idx
  ON oauth_device_authorizations (user_code);
CREATE INDEX IF NOT EXISTS oauth_device_authorizations_expires_idx
  ON oauth_device_authorizations (expires_at);

-- Heal: revoke "broad" tokens (the single-workspace token rule). A token is
-- broad if it carries the defer-scope '*' (the old "Full access" token) or
-- it touches more than one workspace — its own granted_workspace_ids unioned
-- with the owning workspace of every granted Doco (personal, user-owned Docos
-- don't count). Issuance now refuses to mint such tokens; this is the deploy
-- cutover that cuts off any that already exist, plus a permanent backstop
-- (idempotent: only unrevoked rows match, and a fresh DB has none). Pending
-- device-authorizations carrying the same breadth are deleted so they can't
-- mint a broad token on their next poll.
DO $$
DECLARE
  workspace_prefix CONSTANT text := 'workspace_';
BEGIN
  PERFORM pg_advisory_xact_lock(704932187);

  -- Each block is guarded on its table carrying the grant columns this
  -- expects, so the heal is a no-op on an older shape that predates those
  -- columns (the baseline's CREATE TABLE IF NOT EXISTS won't backfill columns
  -- onto a table that already exists) — it only runs once the current shape is
  -- in place, which is the only shape that can hold a broad token.
  IF (SELECT count(*) = 3 FROM information_schema.columns
        WHERE table_name = 'oauth_access_tokens'
          AND column_name IN ('revoked', 'granted_doco_ids', 'granted_workspace_ids')) THEN
    WITH broad AS (
      SELECT t.token
        FROM oauth_access_tokens t
       WHERE t.revoked = false
         AND (
           '*' = ANY(t.granted_doco_ids)
           OR (
             SELECT count(DISTINCT w)
               FROM (
                 SELECT unnest(t.granted_workspace_ids) AS w
                 UNION
                 SELECT d.owner_id
                   FROM docos d
                  WHERE d.id = ANY(t.granted_doco_ids)
                    AND starts_with(d.owner_id, workspace_prefix)
               ) s
              WHERE starts_with(w, workspace_prefix)
           ) > 1
         )
    )
    UPDATE oauth_access_tokens SET revoked = true WHERE token IN (SELECT token FROM broad);
  END IF;

  IF (SELECT count(*) = 3 FROM information_schema.columns
        WHERE table_name = 'oauth_refresh_tokens'
          AND column_name IN ('revoked', 'granted_doco_ids', 'granted_workspace_ids')) THEN
    WITH broad AS (
      SELECT t.token
        FROM oauth_refresh_tokens t
       WHERE t.revoked = false
         AND (
           '*' = ANY(t.granted_doco_ids)
           OR (
             SELECT count(DISTINCT w)
               FROM (
                 SELECT unnest(t.granted_workspace_ids) AS w
                 UNION
                 SELECT d.owner_id
                   FROM docos d
                  WHERE d.id = ANY(t.granted_doco_ids)
                    AND starts_with(d.owner_id, workspace_prefix)
               ) s
              WHERE starts_with(w, workspace_prefix)
           ) > 1
         )
    )
    UPDATE oauth_refresh_tokens SET revoked = true WHERE token IN (SELECT token FROM broad);
  END IF;

  IF (SELECT count(*) = 3 FROM information_schema.columns
        WHERE table_name = 'oauth_device_authorizations'
          AND column_name IN ('status', 'granted_doco_ids', 'granted_workspace_ids')) THEN
    DELETE FROM oauth_device_authorizations da
     WHERE da.status = 'pending'
       AND (
         '*' = ANY(da.granted_doco_ids)
         OR (
           SELECT count(DISTINCT w)
             FROM (
               SELECT unnest(da.granted_workspace_ids) AS w
               UNION
               SELECT d.owner_id
                 FROM docos d
                WHERE d.id = ANY(da.granted_doco_ids)
                  AND starts_with(d.owner_id, workspace_prefix)
             ) s
            WHERE starts_with(w, workspace_prefix)
         ) > 1
       );
  END IF;
END $$;

-- Access requests. Someone who can't (fully) use a Doco asks its owners
-- for a role; an owner approves (writing a doco_users grant — see the
-- access engine) or denies. The PUSH counterpart to invites (which are
-- PULL: an owner mints a link). The partial unique index keeps at most
-- one live (pending) request per (doco, requester); deciding it frees a
-- new one. Connector tokens defer to the matrix, so an approved grant
-- takes effect on the requester's next call with no re-auth.
CREATE TABLE IF NOT EXISTS access_requests (
  id             text PRIMARY KEY,                  -- accreq_<opaque>
  doco_id        text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  requester_id   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_role text NOT NULL CHECK (requested_role IN ('reader','writer','owner')),
  reason         text,
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','denied','cancelled')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz,
  decided_by     text REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS access_requests_doco_status_idx
  ON access_requests (doco_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS access_requests_one_pending_idx
  ON access_requests (doco_id, requester_id) WHERE status = 'pending';

-- Committable read-only "project tokens" for Docos. Distinct from
-- oauth_access_tokens: tied to the Doco (not a user), fixed
-- reader scope on one Doco, no expiry — designed to live in the
-- repo at .doco/project-tokens.json so agents that clone the repo
-- can read the Doco without OAuth. Suitable only when repo-readers
-- = acceptable Doco-readers; the owner mints with explicit
-- confirmation.
CREATE TABLE IF NOT EXISTS doco_project_tokens (
  token                 text PRIMARY KEY,
  doco_id               text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  created_by_user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label                 text,
  revoked               boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  last_used_at          timestamptz
);
CREATE INDEX IF NOT EXISTS doco_project_tokens_doco_idx
  ON doco_project_tokens (doco_id) WHERE NOT revoked;

-- ──────────────────────────────────────────────────────────────────────────
-- Visualization perspectives and the per-Doco attachment join. Ownership is
-- tracked by `owner_handle`.
CREATE TABLE IF NOT EXISTS perspectives (
  id              text PRIMARY KEY,
  slug            text NOT NULL UNIQUE,
  kind            text NOT NULL CHECK (kind IN ('graph','list','bpmn','org-tree','sla','glossary','pull-requests')),
  name            text NOT NULL,
  description     text,
  icon            text,
  owner_handle    text,
  is_builtin      boolean NOT NULL DEFAULT false,
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS perspectives_owner_handle_idx ON perspectives (owner_handle);
CREATE INDEX IF NOT EXISTS perspectives_kind_idx         ON perspectives (kind);

-- Built-in perspectives. host.ts attaches graph/list to every new
-- Doco, so these rows must exist for doco creation to succeed.
INSERT INTO perspectives (id, slug, kind, name, description, icon, owner_handle, is_builtin, config) VALUES
  ('perspective_graph','graph','graph','Graph','Force-directed overview of nodes and edges — the original view.','🕸️',NULL,true,'{}'::jsonb),
  ('perspective_list','list','list','List','Sortable list of nodes, with type-aware tiebreakers.','📋',NULL,true,'{"default_sort":"recent_desc"}'::jsonb),
  ('perspective_bpmn','bpmn','bpmn','BPMN','Business process modeling — swim lanes, gateways, and events. Inspired by BPMN.','🏭','torrenegra',true,'{"lane_axis":"principal"}'::jsonb),
  ('perspective_glossary','glossary','glossary','Glossary','A dictionary-style reading of the Doco''s terminology — canonical headwords, definitions, senses, and aliases laid out like a printed lexicon.','📖',NULL,true,'{"headword_field":"chosen","primary_entity":"decision","definition_field":"decision"}'::jsonb),
  ('perspective_org_tree','org-tree','org-tree','Org Tree','Organizational chart — Principals as members, `has_parent` edges with `reports_to` role as reporting lines, with person vs AI agent shown by icon.','🏢',NULL,true,'{"agent_icon":"🤖","person_icon":"👤","root_edge":"has_parent","root_edge_role":"reports_to","icon_by_member_kind":true}'::jsonb),
  ('perspective_sla','sla','sla','SLAs','Service-level agreement control plane — commitments, owners, evidence links, remedies, and review gaps.','📜',NULL,true,'{"event_logs":false,"primary_entity":"rule","evidence_sources":["eval","reference"]}'::jsonb),
  ('perspective_pull_requests','pull-requests','pull-requests','Pull requests','Imported GitHub pull requests, grouped by lifecycle — merged, open, and closed.','🔀',NULL,true,'{}'::jsonb)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS doco_perspectives (
  doco_id            text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  perspective_id     text NOT NULL REFERENCES perspectives(id) ON DELETE CASCADE,
  position           int  NOT NULL DEFAULT 0,
  is_default         boolean NOT NULL DEFAULT false,
  attached_at        timestamptz NOT NULL DEFAULT now(),
  attached_by_user   text REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (doco_id, perspective_id)
);
CREATE INDEX IF NOT EXISTS doco_perspectives_doco_idx ON doco_perspectives (doco_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS doco_perspectives_one_default
  ON doco_perspectives (doco_id) WHERE is_default;

-- Heal: the "Proposed"/approval perspective was removed. schema.sql is additive
-- (CREATE IF NOT EXISTS / INSERT ON CONFLICT) and re-applied on every boot, so
-- dropping the seed row above does not by itself clear it from databases
-- provisioned earlier. Delete the leftover row here — the ON DELETE CASCADE on
-- doco_perspectives.perspective_id removes any Doco's attachment of it too.
-- Safe to remove once every environment has been re-provisioned without it.
DELETE FROM perspectives WHERE id = 'perspective_approval';

-- In-page assistant chat.
CREATE TABLE IF NOT EXISTS chat_conversations (
  id                       text PRIMARY KEY,
  user_id                  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  archived                 boolean NOT NULL DEFAULT false,
  active_turn_started_at   timestamptz,
  active_turn_events       jsonb NOT NULL DEFAULT '[]'::jsonb,
  title                    text,
  -- The Workspace this thread is scoped to. Señor Doco hard-scopes a thread's
  -- context (docos, policies, constitution) to this Workspace — mirroring an
  -- MCP token bound to one Workspace. Nullable: pre-existing threads (and any
  -- not yet assigned) stay workspace-less and fall back to the broad,
  -- all-reachable context. ON DELETE SET NULL so deleting a Workspace
  -- unassigns its threads rather than destroying chat history.
  workspace_id             text REFERENCES workspaces(id) ON DELETE SET NULL,
  attached_workspace_handles text[] NOT NULL DEFAULT '{}',
  attached_doco_ids        text[] NOT NULL DEFAULT '{}',
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
-- Migration for DBs created before workspace scoping existed.
ALTER TABLE chat_conversations
  ADD COLUMN IF NOT EXISTS workspace_id text REFERENCES workspaces(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_chat_conversations_user_active
  ON chat_conversations (user_id, updated_at DESC) WHERE archived = false;

CREATE TABLE IF NOT EXISTS chat_messages (
  id               text PRIMARY KEY,
  conversation_id  text NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('user','assistant')),
  content          jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_created
  ON chat_messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS chat_attachments (
  id               text PRIMARY KEY,
  conversation_id  text NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename         text NOT NULL,
  mime_type        text NOT NULL,
  size_bytes       integer NOT NULL,
  content          bytea NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL DEFAULT (now() + INTERVAL '30 days')
);
CREATE INDEX IF NOT EXISTS idx_chat_attachments_conversation ON chat_attachments (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_attachments_expires      ON chat_attachments (expires_at);

-- Telemetry. user_id / doco_id are plain text (no FK).
CREATE TABLE IF NOT EXISTS agent_turn_metrics (
  id                       text PRIMARY KEY,
  conversation_id          text NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id                  text NOT NULL,
  model                    text NOT NULL,
  started_at               timestamptz NOT NULL DEFAULT now(),
  total_ms                 integer NOT NULL,
  bootstrap_ms             integer NOT NULL DEFAULT 0,
  history_load_ms          integer NOT NULL DEFAULT 0,
  first_text_token_ms      integer,
  num_anthropic_calls      integer NOT NULL DEFAULT 0,
  num_tool_calls           integer NOT NULL DEFAULT 0,
  input_tokens             integer NOT NULL DEFAULT 0,
  output_tokens            integer NOT NULL DEFAULT 0,
  cache_read_tokens        integer NOT NULL DEFAULT 0,
  cache_creation_tokens    integer NOT NULL DEFAULT 0,
  history_message_count    integer NOT NULL DEFAULT 0,
  attachment_count         integer NOT NULL DEFAULT 0,
  stop_reason              text,
  error                    text,
  phases                   jsonb NOT NULL DEFAULT '{}'::jsonb
);
-- Per-thread usage roll-up (the Thinking panel meter) sums these rows by
-- conversation on every snapshot load; the FK column isn't auto-indexed.
CREATE INDEX IF NOT EXISTS agent_turn_metrics_conversation_idx
  ON agent_turn_metrics (conversation_id);

CREATE TABLE IF NOT EXISTS capture_timings (
  id                          text PRIMARY KEY,
  doco_id                     text NOT NULL,
  entity_type                 text NOT NULL,
  http_method                 text NOT NULL,
  principal_id                text,
  started_at                  timestamptz NOT NULL DEFAULT now(),
  total_ms                    integer NOT NULL,
  persist_ms                  integer NOT NULL DEFAULT 0,
  authoring_ms                integer NOT NULL DEFAULT 0,
  judge_ms                    integer NOT NULL DEFAULT 0,
  judge_calls                 integer NOT NULL DEFAULT 0,
  reindex_structural_ms       integer NOT NULL DEFAULT 0,
  reindex_load_ms             integer NOT NULL DEFAULT 0,
  reindex_load_entity_count   integer NOT NULL DEFAULT 0,
  status_code                 integer,
  user_agent                  text,
  error                       text
);

-- OpenAI usage log.
CREATE TABLE IF NOT EXISTS openai_usage_log (
  id            text PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  model         text NOT NULL,
  input_count   integer NOT NULL DEFAULT 0,
  total_chars   integer NOT NULL DEFAULT 0,
  request_ms    integer,
  ok            boolean NOT NULL DEFAULT true,
  error         text
);

-- Group-chat integrations.
CREATE TABLE IF NOT EXISTS group_chat_installations (
  id                          text PRIMARY KEY,
  provider                    text NOT NULL CHECK (provider IN ('slack','google-chat','discord','other')),
  workspace_id                text NOT NULL,
  workspace_name              text NOT NULL DEFAULT '',
  bot_user_id                 text,
  bot_access_token            text,
  bot_scope                   text[] NOT NULL DEFAULT ARRAY[]::text[],
  installed_by_chat_user_id   text,
  installed_by_user_id        text REFERENCES users(id) ON DELETE SET NULL,
  -- The single Doco workspace this chat team is bound to. The team's
  -- assistant reaches at most this one workspace; null = unbound = no Doco
  -- access (fail closed). This is what stops a linked user's account-wide
  -- permissions from leaking into chat.
  doco_workspace_id           text,
  data                        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, workspace_id)
);
CREATE TABLE IF NOT EXISTS group_chat_channel_connections (
  id                      text PRIMARY KEY,
  provider                text NOT NULL CHECK (provider IN ('slack','google-chat','discord','other')),
  workspace_id            text NOT NULL,
  channel_id              text NOT NULL,
  channel_name            text NOT NULL DEFAULT '',
  target_level            text NOT NULL CHECK (target_level IN ('workspace','doco')),
  target_id               text NOT NULL,
  role                    text NOT NULL CHECK (role IN ('owner','approver','author','reader')),
  created_by_user_id      text REFERENCES users(id) ON DELETE SET NULL,
  data                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, workspace_id, channel_id, target_level, target_id)
);
CREATE TABLE IF NOT EXISTS group_chat_user_links (
  id              text PRIMARY KEY,
  provider        text NOT NULL CHECK (provider IN ('slack','google-chat','discord','other')),
  workspace_id    text NOT NULL,
  chat_user_id    text NOT NULL,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, workspace_id, chat_user_id, user_id)
);
-- One row per group-chat channel the assistant has already spoken in. The
-- presence of a row means "already introduced", so Señor Doco leads only its
-- FIRST message in a channel with the Sonnet/MCP intro and never repeats it.
-- A bare insert with ON CONFLICT DO NOTHING makes the first-time check atomic.
CREATE TABLE IF NOT EXISTS group_chat_channel_intros (
  provider      text NOT NULL CHECK (provider IN ('slack','google-chat','discord','other')),
  workspace_id  text NOT NULL,
  channel_id    text NOT NULL,
  introduced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, workspace_id, channel_id)
);

-- Heal: chat teams are now bound to a single Doco workspace, so the assistant
-- can no longer use a linked user's account-wide permissions. The deploy that
-- introduces the binding column also REVOKES every pre-existing personal link
-- (users re-link after their team is bound). This must run exactly ONCE, so it
-- is guarded on the binding column not yet existing — on a fresh DB the column
-- ships with the CREATE TABLE above (guard false → skip), and after this runs
-- once the ALTER adds it (guard false on every later boot). Until a team is
-- bound, the request-time resolver returns no access regardless, so the hole
-- is closed even before anyone re-links.
DO $$
BEGIN
  IF to_regclass('public.group_chat_installations') IS NOT NULL
     AND to_regclass('public.group_chat_user_links') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_name = 'group_chat_installations'
          AND column_name = 'doco_workspace_id'
     ) THEN
    DELETE FROM group_chat_user_links;
  END IF;
END $$;
ALTER TABLE group_chat_installations ADD COLUMN IF NOT EXISTS doco_workspace_id text;

-- One-shot data migrations (run exactly once across all boots). schema.sql is
-- re-applied every boot, so destructive resets are gated on a marker row here
-- rather than being idempotent in-place.
CREATE TABLE IF NOT EXISTS schema_oneshots (
  name        text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- Heal: chat teams are now bound to a single Doco workspace AT INSTALL TIME, so
-- a team is never installed-but-unbound. Pre-existing Slack state predates that
-- flow (installs with no binding, defaults/links chosen under the old account-
-- wide model), so reset it ONCE — every team must re-install through the new
-- bind-at-install flow and re-authorize. Guarded by a marker so it runs once;
-- a fresh DB has nothing to delete and simply records the marker.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_oneshots WHERE name = 'slack_reset_bind_at_install') THEN
    IF to_regclass('public.group_chat_channel_connections') IS NOT NULL THEN
      DELETE FROM group_chat_channel_connections WHERE provider = 'slack';
    END IF;
    IF to_regclass('public.group_chat_user_links') IS NOT NULL THEN
      DELETE FROM group_chat_user_links WHERE provider = 'slack';
    END IF;
    IF to_regclass('public.group_chat_installations') IS NOT NULL THEN
      DELETE FROM group_chat_installations WHERE provider = 'slack';
    END IF;
    INSERT INTO schema_oneshots (name) VALUES ('slack_reset_bind_at_install');
  END IF;
END $$;

-- Feedback reports.
CREATE TABLE IF NOT EXISTS feedback_reports (
  id                    text PRIMARY KEY,
  report_type           text NOT NULL CHECK (report_type IN ('bug','idea')),
  status                text NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewed','archived')),
  title                 text NOT NULL DEFAULT '',
  body                  text NOT NULL DEFAULT '',
  expected              text NOT NULL DEFAULT '',
  actual                text NOT NULL DEFAULT '',
  severity              text NOT NULL DEFAULT '',
  page_url              text NOT NULL DEFAULT '',
  route_path            text NOT NULL DEFAULT '',
  created_by            text REFERENCES users(id) ON DELETE SET NULL,
  created_by_username   text NOT NULL DEFAULT '',
  client_context        jsonb NOT NULL DEFAULT '{}'::jsonb,
  server_context        jsonb NOT NULL DEFAULT '{}'::jsonb,
  data                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  reviewed_at           timestamptz,
  reviewed_by           text REFERENCES users(id) ON DELETE SET NULL
);

-- ──────────────────────────────────────────────────────────────────────────
-- Append-only guardrails. The commit log + version snapshots are
-- immutable: block UPDATE / DELETE / TRUNCATE on them at the DB level, for
-- EVERY role including superuser — stronger than REVOKE, which superusers
-- bypass. Inserts are allowed; "removal" is a retire VERSION, never a delete.
-- Idempotent (CREATE OR REPLACE + DROP IF EXISTS), so it re-asserts on every
-- cold start.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'node_versions'::regclass
       AND conname = 'node_versions_tx_id_fkey'
       AND confdeltype = 'c'
  ) THEN
    ALTER TABLE node_versions DROP CONSTRAINT IF EXISTS node_versions_tx_id_fkey;
    ALTER TABLE node_versions
      ADD CONSTRAINT node_versions_tx_id_fkey
      FOREIGN KEY (tx_id) REFERENCES changesets(tx_id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'edge_versions'::regclass
       AND conname = 'edge_versions_tx_id_fkey'
       AND confdeltype = 'c'
  ) THEN
    ALTER TABLE edge_versions DROP CONSTRAINT IF EXISTS edge_versions_tx_id_fkey;
    ALTER TABLE edge_versions
      ADD CONSTRAINT edge_versions_tx_id_fkey
      FOREIGN KEY (tx_id) REFERENCES changesets(tx_id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION doco_allow_history_delete_for_doco() RETURNS trigger AS $$
BEGIN
  PERFORM set_config('doco.allow_history_delete', 'on', true);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS docos_allow_history_delete ON docos;
CREATE TRIGGER docos_allow_history_delete
  BEFORE DELETE ON docos
  FOR EACH ROW
  EXECUTE FUNCTION doco_allow_history_delete_for_doco();

CREATE OR REPLACE FUNCTION doco_block_history_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND current_setting('doco.allow_history_delete', true) = 'on'
    AND pg_trigger_depth() > 1
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'history append-only: % on % is not allowed', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['changesets','node_versions','edge_versions'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_append_only_row ON %I', t, t);
    EXECUTE format('CREATE TRIGGER %I_append_only_row BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION doco_block_history_mutation()', t, t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I_append_only_stmt ON %I', t, t);
    EXECUTE format('CREATE TRIGGER %I_append_only_stmt BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION doco_block_history_mutation()', t, t);
  END LOOP;
END $$;

-- ── Lifecycle vocabulary migration ───────────────────────────────────────
-- Rename the in-force stage `asserted` → `active`, make node/edge/policy
-- lifecycle mandatory (NOT NULL, defaulting to `active`), and constrain
-- policies to the two stages they ever occupy (`active`/`retired`).
-- Idempotent: the backfill UPDATEs match nothing after the first run, the
-- SET NOT NULL steps are guarded on is_nullable, and the CHECKs are
-- drop-then-add. The append-only history tables (node_versions /
-- edge_versions) are deliberately left untouched — they record what was
-- true at the time, so historical `asserted` snapshots stay as written.
DO $$
BEGIN
  -- 1. Backfill live rows to the new vocabulary (NULL/asserted → active).
  UPDATE nodes                   SET lifecycle = 'active' WHERE lifecycle IS NULL OR lifecycle = 'asserted';
  UPDATE edges                   SET lifecycle = 'active' WHERE lifecycle = 'asserted';
  -- Policies are constrained to {active, retired} below, and that CHECK
  -- validates every existing row. Normalize ANY out-of-range policy lifecycle
  -- (NULL, asserted, or a stale drafting/proposed left by the old capture
  -- path) to `active` first, so ADD CONSTRAINT can never fail on older data.
  UPDATE policies                SET lifecycle = 'active' WHERE lifecycle IS NULL OR lifecycle NOT IN ('active', 'retired');
  -- `default_node_lifecycle` is optional; guard so very old databases that
  -- predate the column don't error here.
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'docos' AND column_name = 'default_node_lifecycle') THEN
    UPDATE docos SET default_node_lifecycle = 'active' WHERE default_node_lifecycle = 'asserted';
  END IF;

  -- 2. Lifecycle is mandatory and defaults to `active`.
  ALTER TABLE nodes    ALTER COLUMN lifecycle SET DEFAULT 'active';
  ALTER TABLE edges    ALTER COLUMN lifecycle SET DEFAULT 'active';
  ALTER TABLE policies ALTER COLUMN lifecycle SET DEFAULT 'active';

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'nodes' AND column_name = 'lifecycle' AND is_nullable = 'YES') THEN
    ALTER TABLE nodes ALTER COLUMN lifecycle SET NOT NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'policies' AND column_name = 'lifecycle' AND is_nullable = 'YES') THEN
    ALTER TABLE policies ALTER COLUMN lifecycle SET NOT NULL;
  END IF;

  -- 3. Policies are constrained to exactly two stages.
  ALTER TABLE policies DROP CONSTRAINT IF EXISTS policies_lifecycle_check;
  ALTER TABLE policies ADD  CONSTRAINT policies_lifecycle_check
                            CHECK (lifecycle IN ('active','retired'));
END $$;

-- ── Business-processes Intent shape: grade the WHOLE field, never a line ────
-- The seeded business-processes Intent-shape check used to be line-scoped — it
-- graded "the first line" as a brief headline (and, earlier still, also
-- demanded the body spell out trigger/outcome/out-of-scope). Line-shaped
-- grading distorts the field's vector embedding and forces a headline
-- structure into prose, so it is gone: the probabilistic check now reads the
-- ENTIRE `intent` field for a concise process purpose, and the deterministic
-- `field-line-shape` floor is retired outright.
--
-- This converges every already-seeded Doco onto the new shape, from EITHER
-- prior state (the original trigger/outcome/scope spec or the interim
-- first-line spec). Only `predicate.agent_instruction` is persisted, never the
-- prose `policy`. schema.sql is re-applied on every boot, so this carries the
-- change to production.

-- (1) Rewrite the probabilistic Intent spec to the whole-field judge. Matches
-- any Intent probabilistic policy whose instruction still scopes to "first
-- line"; the new text contains no such phrase, so a second boot is a no-op.
UPDATE policies
SET data = jsonb_set(
      data,
      '{predicate,agent_instruction}',
      to_jsonb($intent_purpose_spec$Read the ENTIRE `intent` field. PASS when it identifies a single repeatable business process — recognizable as a verb + object (e.g. `publish a job`), optionally with an adjective or adverb — and reads as a concise statement of that process's purpose. FAIL when no single process is identifiable, when several distinct processes are bundled together, or when it sprawls into a multi-paragraph specification instead of a focused purpose. Grade the whole field; do not privilege or judge any single line.$intent_purpose_spec$::text)
    ),
    updated_at = now()
WHERE kind = 'probabilistic'
  AND data -> 'predicate' -> 'when_node_type' ? 'intent'
  AND data -> 'predicate' ->> 'agent_instruction' ILIKE '%first line%';

-- (2) Retire the deterministic `field-line-shape` floor — the predicate kind no
-- longer exists in the evaluator, so any still-active row must stop firing.
-- Idempotent: the `lifecycle = 'active'` guard makes a second boot a no-op.
UPDATE policies
SET lifecycle = 'retired',
    updated_at = now()
WHERE kind = 'deterministic'
  AND data -> 'predicate' ->> 'sub_kind' = 'field-line-shape'
  AND lifecycle = 'active';

-- ── Business-processes flow-node attachment fires in `drafting` too ─────────
-- The three flow-node ATTACHMENT gates — a flow node `serves` an Intent, an
-- Action is `performed_by` a Principal, a gateway Decision is `decided_by` a
-- Principal — used to fire only on the committed stages (`["queued","active"]`),
-- so a flow node sketched in `drafting` could float free of any Intent or
-- Principal. The template now fires them from `drafting` onward, so no flow
-- node is ever unattached even in a sketch (only the completeness/shape gates
-- stay drafting-exempt). Converge every already-seeded business-processes Doco
-- onto that.
--
-- Matched by the three distinct (edge_type, edge_role, target_node_type) tuples,
-- which are unique to these gates. The actor-coverage `performed_by` nudge
-- carries NO target_node_type (and an `incoming` direction), and the `owned_by`
-- owner gate / `tests` Eval gate carry other roles, so all stay committed-only.
-- Idempotent: the `NOT (... ? 'drafting')` guard makes a second boot a no-op,
-- and the `lifecycle = 'active'` guard leaves retired rows untouched.
UPDATE policies
SET data = jsonb_set(
      data,
      '{fires_when_node_lifecycle}',
      '["drafting", "queued", "active"]'::jsonb,
      true
    ),
    updated_at = now()
WHERE kind = 'deterministic'
  AND lifecycle = 'active'
  AND data -> 'predicate' ->> 'sub_kind' = 'requires_edge_role'
  AND (
        (data -> 'predicate' ->> 'edge_type' = 'supports'
         AND data -> 'predicate' ->> 'edge_role' = 'serves'
         AND data -> 'predicate' ->> 'target_node_type' = 'intent')
     OR (data -> 'predicate' ->> 'edge_type' = 'attributed_to'
         AND data -> 'predicate' ->> 'edge_role' = 'performed_by'
         AND data -> 'predicate' ->> 'target_node_type' = 'principal')
     OR (data -> 'predicate' ->> 'edge_type' = 'attributed_to'
         AND data -> 'predicate' ->> 'edge_role' = 'decided_by'
         AND data -> 'predicate' ->> 'target_node_type' = 'principal')
      )
  AND NOT (data -> 'fires_when_node_lifecycle' ? 'drafting');
