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
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- Slice 3 (docs/simplification-plan.md): the host carries no open-ended bag —
-- every field it needs is a typed column. Drop the never-read `data` jsonb.
-- Idempotent: a no-op on fresh installs (column never created above).
ALTER TABLE hosts DROP COLUMN IF EXISTS data;

-- Bootstrap host row. The seed below keeps /home from 500'ing on a
-- fresh install (every layout reads host config). Idempotent — the
-- ON CONFLICT keeps existing host configs untouched.
INSERT INTO hosts (id, name, visibility)
VALUES ('host', 'Doco', 'public')
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
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- Slice 3: a workspace carries no open-ended bag — handle/name/constitution are
-- typed columns. Drop the never-read `data` jsonb. Idempotent.
ALTER TABLE workspaces DROP COLUMN IF EXISTS data;

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
  prose          text NOT NULL DEFAULT '',   -- unified label/prose for every node type, including the principal's name
  proposer_id               text CONSTRAINT nodes_proposer_fk               REFERENCES users(id) ON DELETE SET NULL,             -- idea → users(id) (OAuth identity)
  -- Promoted scalar columns. Slim-down contract phase: every per-type scalar
  -- moved into `extra` and is dropped below; `kind` is the last one
  -- (eval/state, plus principal human|agent).
  kind         text,                          -- eval, state, principal
  -- Reference dedup key, promoted out of `extra` to its own typed column:
  -- it is the one node domain field with a real column (the PR-import
  -- idempotency lookup indexes it). Null for non-reference nodes.
  locator      text,
  -- Node-shape slim-down: the unified per-node extra bag is the single
  -- home for per-node domain fields — it replaced every per-type promoted
  -- column (except `kind`/`locator`) and the catch-all `data` jsonb (dropped
  -- below). Populated on every write; the read path rebuilds the record's field
  -- bag from this plus the real columns.
  extra   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text
);
CREATE INDEX IF NOT EXISTS nodes_doco_type_idx  ON nodes (doco_id, node_type, created_at DESC);
CREATE INDEX IF NOT EXISTS nodes_doco_life_idx  ON nodes (doco_id, lifecycle);
-- Reference dedupe key on the promoted `locator` column — the PR-import
-- idempotency lookup (github-pr-import.server.ts) is an indexed read on it. The
-- index `nodes_ref_locator_idx` is (re)built in the migration section below,
-- AFTER the `locator` column is added on a DB that predates it, so the index
-- expression always resolves.

-- Entity-shape normalization (slice D): the one sanctioned per-node bag is named
-- `extra` (author-owned, empty by default — the system stores nothing in it). A
-- database provisioned before this rename still calls the column `attributes`;
-- rename it in place HERE, BEFORE the `ADD COLUMN IF NOT EXISTS extra` + the
-- backfill below would otherwise mint a SECOND, empty `extra` column beside it.
-- Guarded on `attributes` still existing (and `extra` not), so it runs once per
-- database and is a no-op on fresh installs and on every boot thereafter. The
-- bag's contents ride along; the reference-dedup index is on the `locator`
-- column, so it is untouched.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'nodes' AND column_name = 'attributes'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'nodes' AND column_name = 'extra'
  ) THEN
    ALTER TABLE nodes RENAME COLUMN attributes TO extra;
  END IF;
END $$;

-- Self-heal: `modality` was a promoted Rule column that capture always wrote
-- as the constant "must" and no reader ever consulted (enforcement modality
-- lives in Policy records, not Rule nodes). Drop it. Idempotent — removed
-- where present, a no-op on fresh installs (never created above).
ALTER TABLE nodes DROP COLUMN IF EXISTS modality;

-- Node-shape slim-down. Add the unified `extra` bag and backfill it from
-- `data` + the retained promoted columns (defensive: the writer already fills
-- it on every write, this only touches rows still on the empty default).
-- Guarded on the `data` column still existing, so a fresh install (which never
-- creates `data`) and a boot after the drop below both skip it — the writer is
-- the only populator once `data` is gone.
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS extra jsonb NOT NULL DEFAULT '{}'::jsonb;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'nodes' AND column_name = 'data'
  ) THEN
    UPDATE nodes
       SET extra = jsonb_strip_nulls(
             COALESCE(data, '{}'::jsonb)
                -- identity / audit / lifecycle live in real columns
                - 'id' - 'doco_id' - 'node_type' - 'lifecycle'
                - 'created_at' - 'created_by' - 'updated_at' - 'updated_by'
                -- prose + its historical aliases live in `prose`
                - 'prose' - 'summary' - 'description'
                -- principal label/body (folded into prose / extra) + dropped flag
                - 'name' - 'body_md' - 'role_principal'
                -- columns we keep promoted
                - 'kind' - 'proposer_id'
                -- the type-named prose field, duplicated into data on old writes
                - 'intent' - 'idea' - 'rule' - 'decision' - 'action'
                - 'log' - 'eval' - 'reference' - 'state')
     WHERE extra = '{}'::jsonb;
  END IF;
END $$;

-- Contract phase: the action/log/rule scalar columns now live in `extra`.
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
       SET extra = extra || jsonb_strip_nulls(jsonb_build_object(
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

-- Contract phase: the reference scalar columns (ref_type / locator / citation
-- / title) now live in `extra`. Fold any straggler values in, then DROP.
-- Guarded on `ref_type` so fresh installs and already-migrated DBs both skip.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'nodes' AND column_name = 'ref_type'
  ) THEN
    UPDATE nodes
       SET extra = extra || jsonb_strip_nulls(jsonb_build_object(
             'ref_type', ref_type, 'locator', locator,
             'citation', citation, 'title', title));
    ALTER TABLE nodes
      DROP COLUMN IF EXISTS ref_type,
      DROP COLUMN IF EXISTS locator,
      DROP COLUMN IF EXISTS citation,
      DROP COLUMN IF EXISTS title;
  END IF;
END $$;

-- Contract phase: principals join the prose nodes. Their `name` becomes `prose`,
-- and `name`/`body_md`/`role_principal` are dropped. `body_md` content is NOT
-- carried into `extra` — the entity-shape normalization gives a principal
-- one text home (`prose`); the body is dropped, no backward compatibility.
-- Guarded on `name` so fresh installs and migrated DBs both skip.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'nodes' AND column_name = 'name'
  ) THEN
    UPDATE nodes
       SET prose = COALESCE(NULLIF(prose, ''), name, id)
     WHERE node_type = 'principal';
    ALTER TABLE nodes
      DROP COLUMN IF EXISTS name,
      DROP COLUMN IF EXISTS body_md,
      DROP COLUMN IF EXISTS role_principal;
  END IF;
END $$;

-- Node-shape slim-down: drop the catch-all `data` jsonb. Every per-node domain
-- field already lives in `extra` (the guarded backfill above folded any
-- stragglers in before this runs), so no further copy is needed. The read path
-- (rowToEntity) now rebuilds a record's field bag from `extra` + the real
-- columns. Idempotent — drops it where present, a no-op on fresh installs (the
-- CREATE TABLE above no longer declares it) and on every boot thereafter.
ALTER TABLE nodes DROP COLUMN IF EXISTS data;

-- Entity-shape normalization: `body_md` is dropped from the node model. No node
-- field lives in `body_md` any more — a principal's text is its `prose`, and a
-- PR Reference keeps the title in `prose` and drops the body. Strip the key from
-- every node's extra bag so the only non-`extra` content is real columns
-- (earlier shapes folded a principal's body / a PR body into the bag). The
-- reference title/body convergence near the end of this file drops the body that
-- still lives inline in a PR reference's `prose`. Idempotent: once stripped, the
-- `?` guard makes a second pass a no-op.
UPDATE nodes SET extra = extra - 'body_md' WHERE extra ? 'body_md';

-- Entity-shape normalization: promote `locator` (the reference dedup key — the
-- one node domain field we keep) out of the `extra` bag into its own typed
-- column. Add the column on a DB that predates it, move the bag value in, then
-- strip the key from the bag. Idempotent: the migrate only fills a still-empty
-- column from the bag, and the `?` guard makes the strip a no-op on a second
-- pass. (The CREATE TABLE above declares the column on fresh installs, where the
-- migrate/strip match nothing.)
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS locator text;
UPDATE nodes SET locator = extra->>'locator'
 WHERE extra ? 'locator' AND (locator IS NULL OR locator = '');
UPDATE nodes SET extra = extra - 'locator' WHERE extra ? 'locator';

-- (Re)build the reference-dedup index on the `locator` column, now that the
-- column exists. Drop the OLD `(extra->>'locator')` expression index first
-- if a DB predates the column (CREATE INDEX IF NOT EXISTS is a no-op on the
-- existing name, so it would otherwise keep the stale expression index).
-- Idempotent: after the repoint the index is column-based, so the DROP guard
-- skips and CREATE IF NOT EXISTS no-ops.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE indexname = 'nodes_ref_locator_idx' AND indexdef LIKE '%extra%'
  ) THEN
    DROP INDEX nodes_ref_locator_idx;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS nodes_ref_locator_idx ON nodes (doco_id, locator) WHERE node_type = 'reference';

-- Entity-shape normalization (slice C): drop the folded reference/rule cruft for
-- good. `ref_type`, `citation`, `severity`, `title`, and `body` were folded into
-- the bag by the column-drop migrations above; the canonical node shape retires
-- them entirely (a reference's type is implied by its `locator`; rule
-- enforcement lives in Policy records, not a `severity` string; the title is the
-- `prose`). Strip the keys from every node's bag. Idempotent: the `?|` guard
-- makes a second pass a no-op once they're gone. The write path also excludes
-- these keys (repo.ts ATTRIBUTE_EXCLUDED_KEYS), so a stale client that still
-- sends one never re-persists it.
UPDATE nodes
   SET extra = extra - 'ref_type' - 'citation' - 'severity' - 'title' - 'body'
 WHERE extra ?| array['ref_type', 'citation', 'severity', 'title', 'body'];

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
  -- flows_to BPMN metadata, promoted from the old `props` jsonb to typed
  -- columns: branch `label`, gateway `condition`, and `kind`
  -- (exception/timer). The edge's `role` qualifier is gone — an edge's meaning
  -- is its type plus the node types it connects, and the live-unique index
  -- below already identifies each edge.
  label           text,
  condition       text,
  kind            text,
  lifecycle       text NOT NULL DEFAULT 'active',
  origin          text NOT NULL DEFAULT 'authored'
                    CHECK (origin IN ('authored')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text,                       -- user_<ulid>
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      text,
  retired_at      timestamptz
);
-- At most one LIVE edge per (doco, from, to, type); retired duplicates ok.
-- Edge `role` is retired, so the relation type alone is the live identity — two
-- nodes are connected by at most one live edge of each type. (The role-removal
-- migration near the end of this file drops the old role-bearing index, dedups
-- any edges that collapse together, and recreates this one.)
CREATE UNIQUE INDEX IF NOT EXISTS edges_live_uniq
  ON edges (
    doco_id,
    from_id,
    to_id,
    edge_type
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
  kind            text NOT NULL CHECK (kind IN ('graph','list','process','org-tree','sla','glossary','pull-requests')),
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

-- Relax the `kind` CHECK and carry the built-in perspective row onto its new
-- identity, BEFORE the seed below (#1062 renamed `bpmn` → `process`). A DB
-- provisioned before #1062 still carries the old CHECK (CREATE TABLE IF NOT
-- EXISTS never alters an existing table's constraint), so the seed's
-- `kind='process'` row would trip it and abort the ENTIRE schema apply — 500'ing
-- every DB-backed route. So: DROP the old constraint and move the row onto
-- `process` HERE, let the seed run constraint-free, then RE-ADD the canonical
-- constraint further down — after the approval-perspective heal — once every
-- stale kind (`bpmn` here, `approval` below) has been normalized, so the re-add
-- never trips on a leftover row. The opaque primary key `perspective_bpmn` is
-- left untouched (referenced by doco_perspectives, never user-visible), so no
-- foreign keys move. Idempotent.
ALTER TABLE perspectives DROP CONSTRAINT IF EXISTS perspectives_kind_check;
UPDATE perspectives
   SET slug = 'process',
       kind = 'process',
       name = 'Process',
       icon = '🔁',
       updated_at = now()
 WHERE id = 'perspective_bpmn'
   AND slug = 'bpmn';

-- Built-in perspectives. host.ts attaches graph/list to every new
-- Doco, so these rows must exist for doco creation to succeed.
INSERT INTO perspectives (id, slug, kind, name, description, icon, owner_handle, is_builtin, config) VALUES
  ('perspective_graph','graph','graph','Graph','Force-directed overview of nodes and edges — the original view.','🕸️',NULL,true,'{}'::jsonb),
  ('perspective_list','list','list','List','Sortable list of nodes, with type-aware tiebreakers.','📋',NULL,true,'{"default_sort":"recent_desc"}'::jsonb),
  ('perspective_bpmn','process','process','Process','Business process modeling — swim lanes, gateways, and events. Inspired by BPMN.','🔁','torrenegra',true,'{"lane_axis":"principal"}'::jsonb),
  ('perspective_glossary','glossary','glossary','Glossary','A dictionary-style reading of the Doco''s terminology — canonical headwords, definitions, senses, and aliases laid out like a printed lexicon.','📖',NULL,true,'{"headword_field":"prose","primary_entity":"reference","definition_field":"definition"}'::jsonb),
  ('perspective_org_tree','org-tree','org-tree','Org Tree','Organizational chart — Principals as members, `has_parent` edges between principals as reporting lines, with person vs AI agent shown by icon.','🏢',NULL,true,'{"agent_icon":"🤖","person_icon":"👤","root_edge":"has_parent","icon_by_member_kind":true}'::jsonb),
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

-- Re-add the canonical `kind` CHECK now that every stale kind has been
-- normalized (the `bpmn` → `process` rename above the seed, and the `approval`
-- delete just above). Pairs with the DROP near the table definition — re-adding
-- here, after the heals, guarantees no leftover row violates it. Idempotent: the
-- DROP IF EXISTS above this on the next boot clears it before this re-adds it.
ALTER TABLE perspectives ADD CONSTRAINT perspectives_kind_check
  CHECK (kind IN ('graph','list','process','org-tree','sla','glossary','pull-requests'));

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
  -- The Doco this thread is attached to. Every in-app Señor Doco chat is
  -- bound to exactly one Doco (1:1 per user — see the unique index below):
  -- opening Señor Doco while viewing a Doco starts/opens that Doco's chat.
  -- workspace_id is derived from this Doco's workspace at creation. Nullable
  -- so pre-existing (workspace-only) threads keep working, and ON DELETE SET
  -- NULL so deleting a Doco preserves the chat history rather than destroying
  -- it (the orphaned thread just loses its Doco tag).
  doco_id                  text REFERENCES docos(id) ON DELETE SET NULL,
  attached_workspace_handles text[] NOT NULL DEFAULT '{}',
  attached_doco_ids        text[] NOT NULL DEFAULT '{}',
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
-- Migration for DBs created before workspace scoping existed.
ALTER TABLE chat_conversations
  ADD COLUMN IF NOT EXISTS workspace_id text REFERENCES workspaces(id) ON DELETE SET NULL;
-- Migration for DBs created before per-Doco chat scoping existed.
ALTER TABLE chat_conversations
  ADD COLUMN IF NOT EXISTS doco_id text REFERENCES docos(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_chat_conversations_user_active
  ON chat_conversations (user_id, updated_at DESC) WHERE archived = false;
-- One chat per (user, Doco). Enforces "a Doco can only have a chat" — the
-- get-or-create path keys on this pair and un-archives rather than minting a
-- second. Partial (doco_id IS NOT NULL) so Doco-less threads stay exempt.
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_conversations_user_doco
  ON chat_conversations (user_id, doco_id) WHERE doco_id IS NOT NULL;

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

-- ── Edge `role` removal ─────────────────────────────────────────────────────
-- Edge roles are retired: an edge's meaning now comes from its type plus its
-- endpoint node types, never a `props.role` tag. This converges already-seeded
-- production data onto the new model. It runs EARLY (before the BP backfills
-- below) so every later migration sees role-free policies. Idempotent: each
-- UPDATE matches only rows still in the old shape, so a second boot is a no-op.

-- (1a) The actor-coverage gate is the one role gate that also carried an
-- exemption. Re-express it structurally: an incoming `attributed_to` from an
-- Action (the performer), exempt when one comes from an Intent (the owner).
UPDATE policies
SET data = jsonb_set(
      data, '{predicate}',
      ((data -> 'predicate') - 'edge_role' - 'exempt_when_role')
        || jsonb_build_object(
             'sub_kind', 'requires_edge',
             'target_node_type', 'action',
             'exempt_when_other_node_type', 'intent'
           )
    ),
    updated_at = now()
WHERE kind = 'deterministic'
  AND data -> 'predicate' ->> 'sub_kind' = 'requires_edge_role'
  AND data -> 'predicate' ->> 'edge_role' = 'performed_by'
  AND data -> 'predicate' ->> 'direction' = 'incoming'
  AND data -> 'predicate' ->> 'exempt_when_role' = 'owned_by';

-- (1b) Every other requires_edge_role → requires_edge (drop the role; the
-- edge_type + target_node_type + when_node_type already carry the distinction).
UPDATE policies
SET data = jsonb_set(
      data, '{predicate}',
      ((data -> 'predicate') - 'edge_role') || '{"sub_kind":"requires_edge"}'::jsonb
    ),
    updated_at = now()
WHERE kind = 'deterministic'
  AND data -> 'predicate' ->> 'sub_kind' = 'requires_edge_role';

-- (1c) limits_edge_role → limits_edge (drop the role).
UPDATE policies
SET data = jsonb_set(
      data, '{predicate}',
      ((data -> 'predicate') - 'edge_role') || '{"sub_kind":"limits_edge"}'::jsonb
    ),
    updated_at = now()
WHERE kind = 'deterministic'
  AND data -> 'predicate' ->> 'sub_kind' = 'limits_edge_role';

-- (1d) Edge-scoped probabilistic policies: drop the now-unused edge_role.
UPDATE policies
SET data = jsonb_set(data, '{predicate}', (data -> 'predicate') - 'edge_role'),
    updated_at = now()
WHERE kind = 'probabilistic'
  AND data -> 'predicate' ? 'edge_type'
  AND data -> 'predicate' ? 'edge_role';

-- (2) Edges: drop the old role-bearing live-uniqueness index, dedup edges that
-- collapse to the same (doco, from, to, type) once role is ignored (keep the
-- oldest, retire the rest — e.g. a performer + owner attribution between the
-- same two nodes merges), strip the role tag, and recreate the role-free index.
DROP INDEX IF EXISTS edges_live_uniq;
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY doco_id, from_id, to_id, edge_type
           ORDER BY created_at, id
         ) AS rn
    FROM edges
   WHERE lifecycle <> 'retired'
)
UPDATE edges
   SET lifecycle = 'retired', updated_at = now()
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
-- Slice 2 (docs/simplification-plan.md): promote the flows_to BPMN metadata
-- (label / condition / kind) from the `props` jsonb to typed columns, then drop
-- `props` entirely (its `role` qualifier goes with it — the live-unique index
-- above is the edge's identity). Guarded on `props` still existing, so fresh
-- installs and an already-migrated DB both skip. The DROP runs after the
-- constraint flush + index rebuild below (DDL can't run with pending events).
--
-- Add the typed columns FIRST, idempotently: `CREATE TABLE IF NOT EXISTS edges`
-- above is a no-op on an existing (pre-Slice-2) DB, so the columns the fold
-- below writes don't exist there yet. Without this, the fold's `SET label = …`
-- aborts the whole schema apply with `column "label" does not exist`.
ALTER TABLE edges ADD COLUMN IF NOT EXISTS label text;
ALTER TABLE edges ADD COLUMN IF NOT EXISTS condition text;
ALTER TABLE edges ADD COLUMN IF NOT EXISTS kind text;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'edges' AND column_name = 'props'
  ) THEN
    UPDATE edges
       SET label     = COALESCE(label, props->>'label'),
           condition = COALESCE(condition, props->>'condition'),
           kind      = COALESCE(kind, props->>'kind')
     WHERE props IS NOT NULL;
  END IF;
END $$;
-- The edges→nodes FKs are DEFERRABLE INITIALLY DEFERRED, so the dedup/strip
-- UPDATEs above queue deferred constraint-trigger events; CREATE INDEX cannot
-- run in a transaction that has pending trigger events. Flush them now (the
-- updated rows still reference live nodes, so the checks pass) before recreating
-- the role-free index.
SET CONSTRAINTS ALL IMMEDIATE;
CREATE UNIQUE INDEX IF NOT EXISTS edges_live_uniq
  ON edges (doco_id, from_id, to_id, edge_type) WHERE lifecycle <> 'retired';

-- Now that the flows_to metadata is folded into typed columns and the deferred
-- constraint events are flushed, drop the `props` jsonb. Guarded + idempotent.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'edges' AND column_name = 'props'
  ) THEN
    ALTER TABLE edges DROP COLUMN props;
  END IF;
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
      to_jsonb($intent_purpose_spec$Read the ENTIRE `prose` field. PASS when it identifies a single repeatable business process — recognizable as a verb + object (e.g. `publish a job`), optionally with an adjective or adverb — and reads as a concise statement of that process's purpose. FAIL when no single process is identifiable, when several distinct processes are bundled together, or when it sprawls into a multi-paragraph specification instead of a focused purpose. Grade the whole field; do not privilege or judge any single line.$intent_purpose_spec$::text)
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

-- ── A node's text has one name everywhere: `prose` ──────────────────────────
-- Slice 1 of the entity-shape normalization (docs/simplification-plan.md): the
-- field bag handed to the authoring-policy judge surfaces a node's text under
-- the single key `prose` — never a type-named key (`intent`/`action`/…) nor a
-- principal `name`. Re-point every deployed probabilistic node spec that still
-- names the old type-named field at `prose`. Each UPDATE is idempotent: the
-- LIKE guard stops matching once the rename is applied, so re-boots are no-ops.
UPDATE policies
SET data = jsonb_set(data, '{predicate,agent_instruction}',
      to_jsonb(replace(data -> 'predicate' ->> 'agent_instruction',
                       'ENTIRE `intent` field', 'ENTIRE `prose` field'))),
    updated_at = now()
WHERE kind = 'probabilistic'
  AND data -> 'predicate' ->> 'agent_instruction' LIKE '%ENTIRE `intent` field%';

UPDATE policies
SET data = jsonb_set(data, '{predicate,agent_instruction}',
      to_jsonb(replace(data -> 'predicate' ->> 'agent_instruction',
                       'the Action''s `action` and `verb`', 'the Action''s `prose` and `verb`'))),
    updated_at = now()
WHERE kind = 'probabilistic'
  AND data -> 'predicate' ->> 'agent_instruction' LIKE '%the Action''s `action` and `verb`%';

-- The process Principal-shape judge reads only the Principal's `prose` now
-- (`body_md` is dropped from the node model). Overwrite the seeded process
-- principal judge to the prose-only text, converging from EITHER prior wording
-- (the original `name and body_md`, or the interim `prose and body_md`). Kept
-- byte-identical to the template (doco-templates.ts). Idempotent via the
-- NOT-LIKE-new-text guard; scoped to the process principal judge by its opening
-- + "names a process actor", so the org-chart "Read the Principal's …" judges
-- are untouched.
UPDATE policies
SET data = jsonb_set(data, '{predicate,agent_instruction}',
      to_jsonb($proc_principal_prose$Check the Principal's `prose`. PASS when it clearly names a process actor — a role, team, external party, or system — and explains what responsibility or boundary it owns in this process. FAIL if it reads like an uncontextualized org-chart person, a vague label (`user`, `team`, `system`) with no process responsibility, or an empty shell with only a bare name.$proc_principal_prose$::text)),
    updated_at = now()
WHERE kind = 'probabilistic'
  AND data -> 'predicate' -> 'when_node_type' ? 'principal'
  AND data -> 'predicate' ->> 'agent_instruction' LIKE 'Check the Principal''s%'
  AND data -> 'predicate' ->> 'agent_instruction' LIKE '%names a process actor%'
  AND data -> 'predicate' ->> 'agent_instruction' NOT LIKE '%only a bare name%';

-- ── Business-processes: backfill the sub-process Intent-naming EDGE policy ────
-- The business-processes template gained an EDGE-scoped probabilistic policy:
-- when a calling Action `serves` a child purpose Intent (a sub-process), the
-- Intent's name must be the base (imperative) form of the third-person Action
-- (`Posts a job` -> `Post a job`). New Docos seed it at creation; this backfills
-- every ALREADY-seeded business-processes Doco that predates the policy so the
-- rule applies to ALL business-process documents. schema.sql is re-applied on
-- every boot, carrying the change to production.
--
-- A Doco is "business-processes" when it carries the seeded membership judge
-- (whose instruction mentions "belongs in business-processes"). The new policy's
-- id is derived deterministically from the doco id, and a NOT EXISTS guard skips
-- any Doco that already has the Action->Intent `serves` edge policy — so a second
-- boot is a no-op (doubly so via ON CONFLICT (id) DO NOTHING).
INSERT INTO policies (id, doco_id, kind, lifecycle, data)
SELECT
  'policy_' || upper(substr(md5(bp.doco_id || '-subprocess-serves-naming'), 1, 26)),
  bp.doco_id,
  'probabilistic',
  'active',
  jsonb_build_object(
    'id', 'policy_' || upper(substr(md5(bp.doco_id || '-subprocess-serves-naming'), 1, 26)),
    'doco_id', bp.doco_id,
    'kind', 'probabilistic',
    'predicate', jsonb_build_object(
      'agent_instruction', $subproc_spec$You are checking a `supports` relationship from an Action (the `action` endpoint) to a purpose Intent (the `intent` endpoint). STEP 1 — decide whether this is a SUB-PROCESS pairing: the Intent names the SAME single activity as the Action, expanded into its own process (e.g. Action `Posts a job` ↔ Intent `Post a job`). If instead the Action is merely one step within a broader process the Intent names (e.g. Action `review the application` supporting Intent `Approve a consumer loan`), this is an ordinary flow-step link, not a sub-process — PASS, the rule does not apply. STEP 2 — for a sub-process pairing, PASS when the Intent's name is the base (imperative) verb form of the Action, i.e. the Action's third-person verb converted to its base form (`Posts a job` → `Post a job`, `Approves the invoice` → `Approve the invoice`). FAIL with `intent name is not the base form of the action` when the Intent's name is in the third-person singular present tense (a verb ending in `-s`) or otherwise does not read as the base-form imperative of the same activity.$subproc_spec$::text,
      'edge_type', 'supports',
      'from_node_type', 'action',
      'to_node_type', 'intent'
    ),
    'on_violation', 'block',
    'template_seeded', true,
    'template_handle', 'business-processes',
    'lifecycle', 'active'
  )
FROM (
  SELECT DISTINCT p.doco_id
  FROM policies p
  WHERE p.kind = 'probabilistic'
    AND p.data -> 'predicate' ->> 'agent_instruction' ILIKE '%belongs in business-processes%'
) bp
WHERE NOT EXISTS (
  SELECT 1 FROM policies x
  WHERE x.doco_id = bp.doco_id
    AND x.data -> 'predicate' ->> 'edge_type'      = 'supports'
    AND x.data -> 'predicate' ->> 'from_node_type' = 'action'
    AND x.data -> 'predicate' ->> 'to_node_type'   = 'intent'
)
ON CONFLICT (id) DO NOTHING;

-- NOTE: Two boot-time UPDATEs that force `fires_when_node_lifecycle` on the
-- business-process flow-node attachment gates used to live here — (1) adding
-- `drafting` to the Principal gates and (2) stripping it from the `serves`→Intent
-- gate. They were one-time convergence for already-seeded Docos, but schema.sql
-- re-applies on EVERY boot, so their `? 'drafting'` guards re-matched the moment
-- an owner edited a gate's lifecycle stages — the next cold-start (deploy /
-- serverless cold start, seconds away) silently reverted the edit. From the
-- owner's view the change "wouldn't save". Convergence is long complete and new
-- Docos get the right stages from the template at seed time (host.ts), so these
-- re-applied UPDATEs were pure liability and have been removed. Owner edits to a
-- policy's lifecycle stages now persist across reboots. See
-- attachment-lifecycle-policy-migration.test.ts for the regression guard.

-- ── Business-processes lifecycle-walk guidance prose ────────────────────────
-- Keep the lifecycle-walk `suggestion`'s prose in sync with the template:
-- a `drafting` sketch may defer serving an Intent (and the other completeness /
-- shape rules) but must still name its actor and decider, each via an
-- `attributed_to` edge to a Principal. Edge `role` is gone, so the prose names
-- the edge by its type + endpoints, not a role tag. Kept byte-identical to the
-- template (doco-templates.ts) so seeded and new Docos converge. Matched by the
-- suggestion's stable opening; the `<> <target>` guard converges ANY earlier
-- wording (including the old role-bearing text) to the current text and makes a
-- second boot a no-op (once equal, the row no longer matches).
UPDATE policies
SET data = jsonb_set(
      data,
      '{predicate,agent_instruction}',
      to_jsonb($bp_lifecycle_walk$Walk a process node through the four-stage lifecycle drafting → queued → active → retired. A `drafting` sketch may be incomplete — serving an Intent, forward `flows_to` wiring, gateway exhaustiveness, milestone naming, and quality are all suspended, so a step can be drafted before its Intent (and BPMN pool) is chosen — except that an Action must still name its actor and a gateway Decision its decider, each via an `attributed_to` edge to a Principal, from the moment it is drafted, so neither floats free of a Principal even in draft. `queue` it (changeset op `queue`) once it supports its Intent and its forward `flows_to` wiring is coherent and the design is ready; `activate` it (op `activate`) when it is the governing, in-force process. Both committed stages — `queued` and `active` — are held to the full shape rules. `retire` a node when it is withdrawn, or `supersede` it when a redesign replaces it (the op creates the replacement and links the two with a `replaces` edge).$bp_lifecycle_walk$::text)
    ),
    updated_at = now()
WHERE kind = 'suggestion'
  AND data -> 'predicate' ->> 'agent_instruction' LIKE 'Walk a process node through the four-stage lifecycle%'
  AND data -> 'predicate' ->> 'agent_instruction' <> $bp_lifecycle_walk$Walk a process node through the four-stage lifecycle drafting → queued → active → retired. A `drafting` sketch may be incomplete — serving an Intent, forward `flows_to` wiring, gateway exhaustiveness, milestone naming, and quality are all suspended, so a step can be drafted before its Intent (and BPMN pool) is chosen — except that an Action must still name its actor and a gateway Decision its decider, each via an `attributed_to` edge to a Principal, from the moment it is drafted, so neither floats free of a Principal even in draft. `queue` it (changeset op `queue`) once it supports its Intent and its forward `flows_to` wiring is coherent and the design is ready; `activate` it (op `activate`) when it is the governing, in-force process. Both committed stages — `queued` and `active` — are held to the full shape rules. `retire` a node when it is withdrawn, or `supersede` it when a redesign replaces it (the op creates the replacement and links the two with a `replaces` edge).$bp_lifecycle_walk$;

-- ── Business-processes: a flow node serves AT MOST one Intent ───────────────
-- New CEILING gate complementing the `serves` attachment FLOOR (≥1 Intent):
-- every flow node (Action, gateway Decision, milestone/event State) serves at
-- most ONE Intent, so combined with the floor it serves EXACTLY one — it lives
-- in a single BPMN pool, at every stage (drafting → queued → active). The
-- template seeds this on new Docos; converge every already-seeded
-- business-processes Doco by inserting the policy where it is missing.
--
-- A business-processes Doco is identified by its serves attachment FLOOR gate
-- (requires_edge / supports / intent), which only that template seeds. (Edge
-- roles are retired — the role-removal migration earlier in this file has
-- already converted any older requires_edge_role rows to requires_edge by the
-- time this runs.) The inserted row matches host.ts's seeded shape so a migrated
-- Doco is indistinguishable from a freshly-created one.
--
-- Idempotent two ways: the NOT EXISTS guard skips any Doco that already carries
-- a limits_edge / supports / intent gate (including freshly-created Docos seeded
-- from the template, whose gate has a different, ULID-shaped id), so a second
-- boot is a no-op; and the id is derived from the doco id with ON CONFLICT DO
-- NOTHING, so a re-run can never mint a duplicate or abort the boot on a PK
-- clash. schema.sql is re-applied on every boot, so this carries the change to
-- production.
INSERT INTO policies (id, doco_id, kind, data, lifecycle, created_at, updated_at)
SELECT
  'policy_' || substr(md5(serves.doco_id || ':limits-serves-one-intent'), 1, 26),
  serves.doco_id,
  'deterministic',
  jsonb_build_object(
    'id', 'policy_' || substr(md5(serves.doco_id || ':limits-serves-one-intent'), 1, 26),
    'doco_id', serves.doco_id,
    'kind', 'deterministic',
    'predicate', jsonb_build_object(
      'sub_kind', 'limits_edge',
      'edge_type', 'supports',
      'target_node_type', 'intent',
      'max_count', 1,
      'when_node_type', jsonb_build_array('action', 'decision', 'state')
    ),
    'on_violation', 'block',
    'fires_when_node_lifecycle', jsonb_build_array('drafting', 'queued', 'active'),
    'template_seeded', true,
    'template_handle', 'business-processes',
    'lifecycle', 'active'
  ),
  'active',
  now(),
  now()
FROM (
  SELECT DISTINCT doco_id
    FROM policies
   WHERE kind = 'deterministic'
     AND lifecycle = 'active'
     AND data -> 'predicate' ->> 'sub_kind' = 'requires_edge'
     AND data -> 'predicate' ->> 'edge_type' = 'supports'
     AND data -> 'predicate' ->> 'target_node_type' = 'intent'
) AS serves
WHERE NOT EXISTS (
  SELECT 1
    FROM policies existing
   WHERE existing.doco_id = serves.doco_id
     AND existing.lifecycle = 'active'
     AND existing.data -> 'predicate' ->> 'sub_kind' = 'limits_edge'
     AND existing.data -> 'predicate' ->> 'edge_type' = 'supports'
     AND existing.data -> 'predicate' ->> 'target_node_type' = 'intent'
)
ON CONFLICT (id) DO NOTHING;

-- ── Org-chart: drop `body_md`; person/agent/vacant reads `kind` + `prose` ────
-- The Principal slim-down promoted a structured `kind` ("human" | "agent"); the
-- entity-shape normalization then dropped `body_md` from the node model
-- entirely. The org-chart template now keys the person/agent/vacant declaration
-- off `kind` and reads a vacant seat's reason from `prose` (a principal's one
-- text home). New org-chart Docos seed the kind+prose policies at creation;
-- every ALREADY-seeded org-chart Doco still carries a `body_md`-bearing judge,
-- the `body_md` guidance prose, AND the deterministic `body_md` presence floor
-- (which, left active, would now block EVERY principal capture). schema.sql is
-- re-applied on every boot, so these statements carry the change to production.
--
-- Scoped to org-chart Docos via `docos.data->>'template_handle'` AND matched by
-- the OLD signature, so no other template's policies are touched. Each statement
-- is guarded so the FIRST boot rewrites the row and EVERY later boot — and a
-- fresh install that already seeds the new text — is a strict no-op.

-- (A) Behaviour-bearing: the probabilistic person/agent/vacant judge now reads
-- `kind` + `prose` (kept byte-identical to the template in
-- packages/host/src/doco-templates.ts so seeded and new Docos converge). Matches
-- ANY prior principal judge still mentioning `body_md` — the body_md-only spec
-- AND the interim kind+body_md spec — so a single block converges either.
UPDATE policies p
SET data = jsonb_set(
      p.data,
      '{predicate,agent_instruction}',
      to_jsonb($orgchart_kind_prose$Read the Principal's `kind` field and its `prose`. PASS if `kind` is `human` (the seat is filled by a person) or `agent` (filled by an AI agent), OR if `kind` is unset AND the `prose` states the seat is currently vacant/open (e.g. 'Vacant — budgeted Staff Engineer seat, reporting to …'). FAIL with a reason if `kind` is unset AND the prose does not declare the seat vacant — the seat must state whether it's filled by a person, filled by an AI agent, or vacant.$orgchart_kind_prose$::text)
    ),
    updated_at = now()
FROM docos d
WHERE p.doco_id = d.id
  AND d.data ->> 'template_handle' = 'org-chart'
  AND p.kind = 'probabilistic'
  AND p.data -> 'predicate' -> 'when_node_type' ? 'principal'
  AND p.data -> 'predicate' ->> 'agent_instruction' LIKE 'Read the Principal''s%'
  AND p.data -> 'predicate' ->> 'agent_instruction' LIKE '%body_md%';

-- (B) Retire the deterministic `body_md` presence floor (requires_field on
-- body_md). Principals no longer carry `body_md`, so left active it would block
-- every org-chart principal capture. Mirror transitionPolicyLifecycle — flip
-- both the column and `data.lifecycle`. Idempotent (only active rows match).
UPDATE policies p
SET lifecycle = 'retired',
    data = jsonb_set(p.data, '{lifecycle}', '"retired"'::jsonb),
    updated_at = now()
FROM docos d
WHERE p.doco_id = d.id
  AND d.data ->> 'template_handle' = 'org-chart'
  AND p.kind = 'deterministic'
  AND p.lifecycle = 'active'
  AND p.data -> 'predicate' ->> 'sub_kind' = 'requires_field'
  AND p.data -> 'predicate' -> 'fields' = '["body_md"]'::jsonb;

-- (C) Prose convergence: the three guidance `suggestion` rows that pointed
-- authors at `body_md` now name `prose`. Only `predicate.agent_instruction` is
-- persisted on a suggestion, so refresh it for already-seeded org-chart Docos.
-- Each matches its stable opening and guards on a NEW distinctive fragment (the
-- prose-naming) so a second boot is a no-op — and so they converge from EITHER
-- the body_md-only or the interim kind+body_md wording.

-- (C1) "Person vs agent isn't about who signed in …" → says so in its `prose`.
UPDATE policies p
SET data = jsonb_set(
      p.data,
      '{predicate,agent_instruction}',
      to_jsonb($orgchart_person_vs_agent$Person vs agent isn't about who signed in — it's about who fills the seat, declared in the `kind` field. A Principal with `kind: agent` (a code reviewer, a triage bot, a research agent) is an agent regardless of whether any User has signed in as it. A Principal with `kind: human` is a person, even if that human has no Doco account. A vacant seat sets no `kind` and says so in its `prose`.$orgchart_person_vs_agent$::text)
    ),
    updated_at = now()
FROM docos d
WHERE p.doco_id = d.id
  AND d.data ->> 'template_handle' = 'org-chart'
  AND p.kind = 'suggestion'
  AND p.data -> 'predicate' ->> 'agent_instruction' LIKE 'Person vs agent isn''t about who signed in%'
  AND p.data -> 'predicate' ->> 'agent_instruction' NOT LIKE '%says so in its `prose`%';

-- (C2) "Treat each Principal as a seat …" → a filled seat sets `kind`; a vacant
-- one leaves `kind` unset and declares itself in its `prose`.
UPDATE policies p
SET data = jsonb_set(
      p.data,
      '{predicate,agent_instruction}',
      to_jsonb($orgchart_seat_vacant$Treat each Principal as a seat — a role plus its current occupant — not just a person. A filled seat sets `kind` to `human` or `agent`; a budgeted-but-unfilled seat is still a valid Principal: leave `kind` unset, declare it `vacant` in its `prose`, name the role it's budgeted for, and keep its reporting edge so the tree stays complete. Omitting open roles hides headcount and distorts the reporting structure.$orgchart_seat_vacant$::text)
    ),
    updated_at = now()
FROM docos d
WHERE p.doco_id = d.id
  AND d.data ->> 'template_handle' = 'org-chart'
  AND p.kind = 'suggestion'
  AND p.data -> 'predicate' ->> 'agent_instruction' LIKE 'Treat each Principal as a seat%'
  AND p.data -> 'predicate' ->> 'agent_instruction' NOT LIKE '%declare it `vacant` in its `prose`%';

-- (C3) "Seats persist across routine turnover …" → clear/restore `kind`, and a
-- person↔agent flip (kind: human ↔ kind: agent) retires + recreates.
UPDATE policies p
SET data = jsonb_set(
      p.data,
      '{predicate,agent_instruction}',
      to_jsonb($orgchart_turnover$Seats persist across routine turnover: when one person leaves and another fills the same seat — or a seat goes vacant and is later refilled by the same kind of occupant — keep the Principal, update its `prose` (and clear or restore `kind` as the seat empties or refills), and record the change as a Decision, so reporting and membership edges stay intact and the seat's history reads continuously. Only when the seat's nature flips between person (`kind: human`) and AI agent (`kind: agent`) do you retire the old Principal and create a new one.$orgchart_turnover$::text)
    ),
    updated_at = now()
FROM docos d
WHERE p.doco_id = d.id
  AND d.data ->> 'template_handle' = 'org-chart'
  AND p.kind = 'suggestion'
  AND p.data -> 'predicate' ->> 'agent_instruction' LIKE 'Seats persist across routine turnover%'
  AND p.data -> 'predicate' ->> 'agent_instruction' NOT LIKE '%update its `prose`%';

-- (C4) "AI-agent Principals that act on a human's behalf …" → declare the human
-- in the agent's `prose` (not `body_md`). Targeted phrase replace, idempotent.
UPDATE policies p
SET data = jsonb_set(
      p.data,
      '{predicate,agent_instruction}',
      to_jsonb(replace(p.data -> 'predicate' ->> 'agent_instruction',
        'declare that human via prose in `body_md`',
        'declare that human in their `prose`'))
    ),
    updated_at = now()
FROM docos d
WHERE p.doco_id = d.id
  AND d.data ->> 'template_handle' = 'org-chart'
  AND p.kind = 'suggestion'
  AND p.data -> 'predicate' ->> 'agent_instruction' LIKE '%declare that human via prose in `body_md`%';

-- ── Edge-type allowlist backfill (requires_edge_type) ───────────────────────
-- Each Doco template now declares which relationship edge types it permits (the
-- edge analogue of the node-type allowlist). New Docos get it at seed time; this
-- converges already-seeded Docos, one template at a time, identified by that
-- template's node-type allowlist fingerprint (exact set match, order-independent).
-- Idempotent: the NOT EXISTS guard skips any Doco that already carries a
-- requires_edge_type policy (including freshly-seeded ones), and the derived id +
-- ON CONFLICT DO NOTHING prevents duplicates. schema.sql re-applies every boot,
-- carrying this to production.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('business-processes',
       '["intent","action","decision","state","eval","reference","rule","principal"]'::jsonb,
       '["flows_to","supports","attributed_to","constrained_by","replaces","derived_from"]'::jsonb),
      ('org-chart',
       '["principal","intent","decision","reference","rule"]'::jsonb,
       '["has_parent","attributed_to","relates_to","supports","replaces","derived_from"]'::jsonb),
      ('glossaries',
       '["decision","rule","reference","eval"]'::jsonb,
       '["relates_to","derived_from","replaces","supports"]'::jsonb),
      ('decision-records',
       '["intent","decision","eval","reference","rule","principal"]'::jsonb,
       '["supports","attributed_to","relates_to","replaces","derived_from"]'::jsonb)
    ) AS v(handle, node_types, edge_types)
  LOOP
    INSERT INTO policies (id, doco_id, kind, data, lifecycle, created_at, updated_at)
    SELECT
      'policy_' || substr(md5(nt.doco_id || ':edge-type-allowlist'), 1, 26),
      nt.doco_id,
      'deterministic',
      jsonb_build_object(
        'id', 'policy_' || substr(md5(nt.doco_id || ':edge-type-allowlist'), 1, 26),
        'doco_id', nt.doco_id,
        'kind', 'deterministic',
        'predicate', jsonb_build_object('sub_kind', 'requires_edge_type', 'edge_types', t.edge_types),
        'on_violation', 'block',
        'template_seeded', true,
        'template_handle', t.handle,
        'lifecycle', 'active'
      ),
      'active', now(), now()
    FROM (
      SELECT DISTINCT doco_id
        FROM policies
       WHERE kind = 'deterministic'
         AND lifecycle = 'active'
         AND data -> 'predicate' ->> 'sub_kind' = 'requires_node_type'
         AND data -> 'predicate' -> 'node_types' @> t.node_types
         AND data -> 'predicate' -> 'node_types' <@ t.node_types
    ) AS nt
    WHERE NOT EXISTS (
      SELECT 1 FROM policies x
       WHERE x.doco_id = nt.doco_id
         AND x.lifecycle = 'active'
         AND x.data -> 'predicate' ->> 'sub_kind' = 'requires_edge_type'
    )
    ON CONFLICT (id) DO NOTHING;
  END LOOP;
END $$;

-- Reference title/body DROP: PR references were once stored prose="title\n\nbody"
-- (a later migration split the body out into extra.body_md). The
-- entity-shape normalization drops the PR body entirely — a Reference's text is
-- the title in `prose`, with no body anywhere — so truncate any PR-reference
-- prose down to the title. (The strip-`body_md` migration near the top of this
-- file removes the bag copy the old split wrote; this removes the body that is
-- still inline in an un-split reference's prose.) Scoped to PR-URL references so
-- hand-written or code-locator references are untouched. Idempotent: after the
-- truncation the prose has no blank line, so a second pass skips it; a title-only
-- PR ref (no blank line) is never touched. The derived FTS / embedding rows still
-- carry title+body until the reference is next re-captured, at which point
-- `nodeIndexText` rebuilds them from the title alone.
UPDATE nodes
   SET prose = left(prose, position(E'\n\n' IN prose) - 1)
 WHERE node_type = 'reference'
   AND position(E'\n\n' IN prose) > 0
   AND locator ~ '^https?://github\.com/[^/]+/[^/]+/pull/[0-9]+$';
-- ── torre-bpm policy convergence (older template snapshot → current) ─────────
-- torre-bpm (doco_01KT7G5PCX4273VHWW8SAAVSJC) was seeded from the business-processes template BEFORE
-- the "an edge's meaning comes from its type + endpoints, not a role tag"
-- refactor. Its deterministic predicates were already converged by the edge
-- `role` removal block above, but the prose (suggestion / edge-probabilistic)
-- policies still carry the old `serves` / `performed_by` / `owned_by` /
-- "role metadata" wording, one ceiling rule was left retired, and one guidance
-- policy was never seeded. This converges that one Doco's policies onto the
-- current template text. Scoped to the single doco_id on purpose (a targeted
-- backfill, not a global model change). Each statement matches only rows still
-- in the stale shape, so re-applying schema.sql on a later boot is a no-op, and
-- it no-ops entirely on any database that doesn't contain this Doco.

  -- sub-process judge
  UPDATE policies SET
       data = jsonb_set(data, '{predicate,agent_instruction}', to_jsonb('You are checking a `supports` relationship from an Action (the `action` endpoint) to a purpose Intent (the `intent` endpoint). STEP 1 — decide whether this is a SUB-PROCESS pairing: the Intent names the SAME single activity as the Action, expanded into its own process (e.g. Action `Posts a job` ↔ Intent `Post a job`). If instead the Action is merely one step within a broader process the Intent names (e.g. Action `review the application` supporting Intent `Approve a consumer loan`), this is an ordinary flow-step link, not a sub-process — PASS, the rule does not apply. STEP 2 — for a sub-process pairing, PASS when the Intent''s name is the base (imperative) verb form of the Action, i.e. the Action''s third-person verb converted to its base form (`Posts a job` → `Post a job`, `Approves the invoice` → `Approve the invoice`). FAIL with `intent name is not the base form of the action` when the Intent''s name is in the third-person singular present tense (a verb ending in `-s`) or otherwise does not read as the base-form imperative of the same activity.'::text)),
       updated_at = now()
   WHERE doco_id = 'doco_01KT7G5PCX4273VHWW8SAAVSJC'
     AND data -> 'predicate' ->> 'agent_instruction' LIKE '%`serves` relationship from an Action%';

  -- whole-step sub-process
  UPDATE policies SET
       data = jsonb_set(data, '{predicate,agent_instruction}', to_jsonb('When a step is itself a whole sub-process, model it as its own child process Intent and connect the calling Action to it with a `supports` edge instead of inlining dozens of Actions. The BPMN view collapses the child Intent into its own pool, keeping the parent process readable.'::text)),
       updated_at = now()
   WHERE doco_id = 'doco_01KT7G5PCX4273VHWW8SAAVSJC'
     AND data -> 'predicate' ->> 'agent_instruction' LIKE '%connect the calling Action with a `serves` relationship%';

  -- accountable owner
  UPDATE policies SET
       data = jsonb_set(data, '{predicate,agent_instruction}', to_jsonb('Name the single accountable process owner in the purpose Intent and link it with an `attributed_to` edge from the Intent to that Principal — the one answerable for the whole process''s outcome. This is the RACI ''Accountable'' party, distinct from the per-step ''Responsible'' performers, each named by an `attributed_to` edge from their Action.'::text)),
       updated_at = now()
   WHERE doco_id = 'doco_01KT7G5PCX4273VHWW8SAAVSJC'
     AND data -> 'predicate' ->> 'agent_instruction' LIKE '%carrying role `owned_by`%';

  -- agents/changeset
  UPDATE policies SET
       data = jsonb_set(data, '{predicate,agent_instruction}', to_jsonb('Agents should read `GET /<handle>/api/authoring-contract.json` and write structured flows with `POST /<handle>/api/changesets.json`; create flow nodes and their relationship edges in the same changeset, using the contract''s edge types instead of disconnected nodes or ad hoc relationship names.'::text)),
       updated_at = now()
   WHERE doco_id = 'doco_01KT7G5PCX4273VHWW8SAAVSJC'
     AND data -> 'predicate' ->> 'agent_instruction' LIKE '%contract''s role examples%';

  -- BPMN vocabulary
  UPDATE policies SET
       data = jsonb_set(data, '{predicate,agent_instruction}', to_jsonb('BPMN vocabulary — an edge''s meaning comes from its type plus the node types it connects, not from any role tag: `flows_to` is process order and renders source -> target with no reversal; a `supports` edge from a flow node to an Intent places it in that Intent''s pool; an `attributed_to` edge to a Principal drives actor lanes (from an Action), gateway deciders (from a Decision), and process ownership (from the purpose Intent); a `constrained_by` edge to a Rule links a policy guard; a `supports` edge from an Eval tests the node it points at, and `supports` edges from other nodes carry rationale and evidence.'::text)),
       updated_at = now()
   WHERE doco_id = 'doco_01KT7G5PCX4273VHWW8SAAVSJC'
     AND data -> 'predicate' ->> 'agent_instruction' LIKE '%BPMN vocabulary: `flows_to`%';

  -- relationships=edges
  UPDATE policies SET
       data = jsonb_set(data, '{predicate,agent_instruction}', to_jsonb('Relationships in a business-processes Doco are first-class edges with lifecycle and history. Use `flows_to` for process order and the canonical families (`supports`, `attributed_to`, `constrained_by`, `has_parent`, `derived_from`, `replaces`, `relates_to`); an edge''s specialized meaning comes from its type plus the node types it connects, not from a role tag. Re-point by retiring the old edge and adding the new one; endpoints are immutable.'::text)),
       updated_at = now()
   WHERE doco_id = 'doco_01KT7G5PCX4273VHWW8SAAVSJC'
     AND data -> 'predicate' ->> 'agent_instruction' LIKE '%with role metadata for specialized meanings%';

  -- use queued
  UPDATE policies SET
       data = jsonb_set(data, '{predicate,agent_instruction}', to_jsonb('Use `queued` for a process — or a single step, gateway, or milestone — that is fully wired and ready but not yet in force: a redesign awaiting sign-off, a step pending a scheduled go-live, or an approved-but-not-yet-rolled-out change. A `queued` node asserts readiness, so it must already satisfy the same actor attribution, supporting Intent, and forward-flow wiring an `active` node does. If it is still being sketched and that wiring is incomplete, leave it `drafting` instead of queuing it.'::text)),
       updated_at = now()
   WHERE doco_id = 'doco_01KT7G5PCX4273VHWW8SAAVSJC'
     AND data -> 'predicate' ->> 'agent_instruction' LIKE '%actor, `serves`, and forward-flow%';

  -- lifecycle walk
  UPDATE policies SET
       data = jsonb_set(data, '{predicate,agent_instruction}', to_jsonb('Walk a process node through the four-stage lifecycle drafting → queued → active → retired. A `drafting` sketch may be incomplete — serving an Intent, naming the actor or decider Principal (an Action''s or gateway Decision''s `attributed_to` edge to a Principal), forward `flows_to` wiring, gateway exhaustiveness, milestone naming, and quality are all suspended, so a step can be drafted before its actor, decider, or Intent (and BPMN pool) is chosen. `queue` it (changeset op `queue`) once it supports its Intent and its forward `flows_to` wiring is coherent and the design is ready; `activate` it (op `activate`) when it is the governing, in-force process. Both committed stages — `queued` and `active` — are held to the full shape rules. `retire` a node when it is withdrawn, or `supersede` it when a redesign replaces it (the op creates the replacement and links the two with a `replaces` edge).'::text)),
       updated_at = now()
   WHERE doco_id = 'doco_01KT7G5PCX4273VHWW8SAAVSJC'
     AND data -> 'predicate' ->> 'agent_instruction' LIKE '%from the moment it is drafted, so neither floats free%';

  -- custom BPM-import guide: its one stale edge reference (`performed_by`, a
  -- retired role tag) → the `attributed_to` edge that now carries that meaning.
  -- Targeted substring rewrite so the rest of the (large) instruction is left
  -- byte-for-byte intact; idempotent because the matched phrase is gone after.
  UPDATE policies SET
       data = jsonb_set(
                data, '{predicate,agent_instruction}',
                to_jsonb(replace(
                  data -> 'predicate' ->> 'agent_instruction',
                  'Honor the lane for `performed_by`,',
                  'Honor the lane as the Action''s `attributed_to` edge to its Principal,'
                ))
              ),
       updated_at = now()
   WHERE doco_id = 'doco_01KT7G5PCX4273VHWW8SAAVSJC'
     AND data -> 'predicate' ->> 'agent_instruction' LIKE '%Honor the lane for `performed_by`,%';

  -- Re-assert the "a committed flow node belongs to AT MOST one Intent pool"
  -- ceiling (limits_edge supports→intent max 1). The template ships it active;
  -- on torre-bpm it was left retired by seed/dedup churn. Mirror
  -- transitionPolicyLifecycle: flip both the column and data.lifecycle.
  UPDATE policies SET
       lifecycle = 'active',
       data = jsonb_set(data, '{lifecycle}', '"active"'::jsonb),
       updated_at = now()
   WHERE doco_id = 'doco_01KT7G5PCX4273VHWW8SAAVSJC'
     AND kind = 'deterministic'
     AND lifecycle = 'retired'
     AND data -> 'predicate' ->> 'sub_kind' = 'limits_edge'
     AND data -> 'predicate' ->> 'edge_type' = 'supports'
     AND data -> 'predicate' ->> 'target_node_type' = 'intent'
     AND data -> 'predicate' ->> 'max_count' = '1';

  -- Backfill the one template guidance policy torre-bpm never received
  -- ("Name a sub-process by pairing…"). Fixed id keeps the INSERT idempotent.
  INSERT INTO policies (id, doco_id, kind, lifecycle, data, created_at, updated_at)
  SELECT 'policy_torrebpm_name_subprocess_guidance', 'doco_01KT7G5PCX4273VHWW8SAAVSJC', 'suggestion', 'active',
         jsonb_build_object(
           'id', 'policy_torrebpm_name_subprocess_guidance',
           'doco_id', 'doco_01KT7G5PCX4273VHWW8SAAVSJC',
           'kind', 'suggestion',
           'predicate', jsonb_build_object('agent_instruction', 'Name a sub-process by pairing a calling Action with a child purpose Intent through a `supports` edge, and derive the Intent''s name from that Action: take the base form (the imperative) of the Action''s verb, which is normally written third-person. For example, the Action `Posts a job` becomes the child Intent `Post a job`. The two read as the same activity — one as the work performed, one as the goal it serves.'::text),
           'lifecycle', 'active',
           'created_at', now()::text
         ),
         now(), now()
   WHERE EXISTS (SELECT 1 FROM docos WHERE id = 'doco_01KT7G5PCX4273VHWW8SAAVSJC')
     AND NOT EXISTS (SELECT 1 FROM policies WHERE id = 'policy_torrebpm_name_subprocess_guidance');
-- ── end torre-bpm policy convergence ────────────────────────────────────────

-- ── Rename the "business-processes" template → "process" (handle + perspective) ─
-- The template handle and its default perspective were renamed from
-- `business-processes`/`bpmn` to `process`. New Docos seed the new identity at
-- creation (host.ts / doco-templates.ts) and a fresh DB seeds the perspective
-- row directly above; this converges already-seeded production data. Every
-- statement is guarded on the OLD value so a second boot is a no-op, and the
-- whole section no-ops on a database that never carried the old names.
--
-- This runs AFTER the convergence blocks above, which still fingerprint older
-- Docos by their `business-processes` handle / "belongs in business-processes"
-- membership prose — they fire first on the upgrade boot, then the rewrites
-- below carry every row onto the new `process` name.

-- (1) Doco template handle on the doco record. (No `updated_at` touch: the
-- other `UPDATE docos` convergence statements omit it too, keeping this safe on
-- pre-`updated_at` database snapshots.)
UPDATE docos
   SET data = jsonb_set(data, '{template_handle}', '"process"'::jsonb)
 WHERE data ->> 'template_handle' = 'business-processes';

-- (2) The `template_handle` stamped on template-seeded policies.
UPDATE policies
   SET data = jsonb_set(data, '{template_handle}', '"process"'::jsonb),
       updated_at = now()
 WHERE data ->> 'template_handle' = 'business-processes';

-- (3) The membership judge's prose ("A node belongs in business-processes …").
UPDATE policies
   SET data = jsonb_set(
         data,
         '{predicate,agent_instruction}',
         to_jsonb(replace(data -> 'predicate' ->> 'agent_instruction',
                          'belongs in business-processes',
                          'belongs in process'))
       ),
       updated_at = now()
 WHERE data -> 'predicate' ->> 'agent_instruction' LIKE '%belongs in business-processes%';

-- (4) The built-in perspective row (slug/kind/name/icon) and its `kind` CHECK
-- are migrated `bpmn` → `process` up where the perspectives table is defined —
-- it MUST run before the built-in seed, or the seed's `kind='process'` row trips
-- the old constraint and aborts the whole apply. See that block above.
-- ── end business-processes → process rename ─────────────────────────────────

-- ── Process model: promote process Intents to Actions ───────────────────────
-- The BPMN/process perspective no longer groups work under Intents. A process
-- is now an Action with `has_parent` children (its members). Existing process
-- Docos modeled pools as Intents and membership as `supports` (flow node →
-- Intent), so migrate them ONCE:
--
--   • Each Intent in a `process` Doco is renamed `intent_<ulid>` → `action_<ulid>`
--     and its node_type set to `action`. The id prefix is load-bearing (the
--     authoring evaluator types edge endpoints from the id), so the rename
--     cascades to every table that references a node id — edges (real FKs,
--     DEFERRABLE), node_versions, embeddings, entity_fts_nodes, audit_events.
--   • Each membership edge — a flow node's `supports` → that former Intent —
--     becomes `has_parent` → the promoted Action.
--
-- Guarded by a one-shot marker; a fresh DB has no process Intents and simply
-- records the marker. Runs AFTER the business-processes → process rename above,
-- so process Docos already carry template_handle = 'process'.
DO $$
DECLARE rec record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_oneshots WHERE name = 'process_intent_to_action') THEN
    IF to_regclass('public.nodes') IS NOT NULL AND to_regclass('public.edges') IS NOT NULL THEN
      -- The repoint below UPDATEs node_versions so a renamed node carries its
      -- history forward. node_versions is APPEND-ONLY — a BEFORE UPDATE/DELETE
      -- trigger raises `history append-only: UPDATE on node_versions is not
      -- allowed`, which aborts the WHOLE schema apply (and thus every DB op,
      -- because ensureSchema runs schema.sql on cold start) the moment a process
      -- Intent has any version history. Suspend that guard for this controlled
      -- one-shot id-rename, then restore it. The whole apply is one transaction,
      -- so a failure rolls the trigger state back to enabled too.
      ALTER TABLE node_versions DISABLE TRIGGER USER;
      FOR rec IN
        SELECT n.id AS old_id, ('action_' || substr(n.id, 8)) AS new_id
          FROM nodes n
          JOIN docos d ON d.id = n.doco_id
         WHERE n.node_type = 'intent'
           AND d.data ->> 'template_handle' IN ('process', 'business-processes')
      LOOP
        -- Insert the promoted Action under the new id (copying the Intent's
        -- columns), re-point everything that referenced the old id, then drop
        -- the old Intent. This insert-then-repoint-then-delete order keeps the
        -- edges→nodes FKs satisfied at every step (no reliance on deferral):
        -- both ids exist while edges move, and the old node is removed only
        -- once nothing points at it.
        INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, proposer_id, kind, locator,
                           extra, created_at, created_by, updated_at, updated_by)
          SELECT rec.new_id, doco_id, 'action', lifecycle, prose, proposer_id, kind, locator,
                 extra, created_at, created_by, updated_at, updated_by
            FROM nodes WHERE id = rec.old_id;
        UPDATE edges           SET from_id   = rec.new_id WHERE from_id   = rec.old_id;
        UPDATE edges           SET to_id     = rec.new_id WHERE to_id     = rec.old_id;
        UPDATE node_versions   SET entity_id = rec.new_id WHERE entity_id = rec.old_id;
        UPDATE embeddings      SET entity_id = rec.new_id WHERE entity_id = rec.old_id;
        UPDATE entity_fts_nodes SET entity_id = rec.new_id WHERE entity_id = rec.old_id;
        UPDATE audit_events    SET entity_id = rec.new_id WHERE entity_id = rec.old_id;
        DELETE FROM nodes WHERE id = rec.old_id;
        -- A flow node's `supports` → this former Intent WAS its pool membership;
        -- it is now `has_parent` → the promoted process Action.
        UPDATE edges
           SET edge_type = 'has_parent', to_node_type = 'action'
         WHERE to_id = rec.new_id
           AND edge_type = 'supports'
           AND from_node_type IN ('action', 'decision', 'state');
        -- Any remaining edge endpoint that still typed the node as an Intent.
        UPDATE edges SET to_node_type   = 'action' WHERE to_id   = rec.new_id AND to_node_type   = 'intent';
        UPDATE edges SET from_node_type = 'action' WHERE from_id = rec.new_id AND from_node_type = 'intent';
      END LOOP;
      -- Restore the append-only guard now the one-shot repoint is done.
      ALTER TABLE node_versions ENABLE TRIGGER USER;
    END IF;
    INSERT INTO schema_oneshots (name) VALUES ('process_intent_to_action');
  END IF;
END $$;
-- ── end process-Intent → Action promotion ───────────────────────────────────
