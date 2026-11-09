-- Doco Postgres schema (decision_01KRKEVEE3RQGPWHAPMZ0MS9G9).
--
-- Source-of-truth + read-side index in one database per host.
--
-- Single-database, multi-tenant: every entity carries its `collection_id`
-- which scopes it to the owning collection. Hosts can hold thousands of
-- collection instances in one database.
--
-- Schema rules:
--   - `nodes` stores every graph entity, discriminated by `node_type`.
--   - Policies, users, workspaces, and collections live in dedicated tables.
--   - `edges` stores relationships between nodes for graph queries.
--   - `audit_events` stores structured mutation history.
--
-- Vocabulary:
--   nodes   — graph entities (10 types: intent/idea/rule/decision/action/
--               log/eval/reference/state/principal)
--   policies — collection-level authoring metadata (one `policies` table; each
--               row's `kind` is suggestion / deterministic / probabilistic)
--   edges   — relationships between nodes
--   users      — human OAuth identities, separate from principals
--                (which are role-personas linked by graph edges).

-- Host config (singleton row at id='host').
CREATE TABLE IF NOT EXISTS hosts (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  visibility  text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE hosts DROP COLUMN IF EXISTS external_vector_index_enabled;

-- Bootstrap host row. The seed below keeps /home from 500'ing on a
-- fresh install (every layout reads host config). Idempotent — the
-- ON CONFLICT keeps existing host configs untouched.
INSERT INTO hosts (id, name, visibility)
VALUES ('host', 'Doco', 'public')
ON CONFLICT (id) DO NOTHING;

-- Identity layer.
--
-- Two distinct concerns, split into two tables:
--   `users`      — the humans who sign in, with their email, a password and a
--                  second factor (decision_01M644G5305NGN9JB7XJPRGN9H). Authored
--                  nodes via `created_by` / `updated_by`. Members of
--                  workspaces/collections. OAuth clients/tokens have names on
--                  the token rows; they are not represented as user rows.
--   `principals` — role-personas (the "actor" in a documented business
--                  process). Linked from work through first-class edges.

CREATE TABLE IF NOT EXISTS users (
  id              text PRIMARY KEY,            -- user_<ulid>
  -- The person's name in Doco, unique regardless of case
  -- (decision_01M5EAAX2VT2MMRG0ZGKDJGMJZ).
  username        text,
  -- What they are called, as their profile (/users/<username>) says it:
  -- "Alex Torrenegra". Null until they write it, and their username stands in.
  name            text,
  -- The GitHub account the person is, for matching GitHub's events (a pull
  -- request's author) to them; nothing signs in with it.
  github_login    text,
  -- Where Doco emails them, and the links that create their account or replace
  -- a lost password or second factor; unique regardless of case.
  email           text,
  -- Their password as `scrypt$<salt>$<key>`; they sign in with it, their
  -- email and a second factor: a passkey, authenticator app or one of the
  -- app's recovery codes
  -- (decision_01M644G5305NGN9JB7XJPRGN9H). Null until they choose one.
  password_hash   text,
  -- What every session and emailed link of theirs carries; a new one ends them
  -- all (decision_01M644H4Y6SAKGVX7HK0TNG65R).
  stamp           text NOT NULL DEFAULT gen_random_uuid()::text,
  data            jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deactivated_at  timestamptz,
  -- Whether anyone, signed out too, may open their profile, with what they
  -- did in public collections and its share image. Off unless they turn it on.
  public_profile  boolean NOT NULL DEFAULT false,
  -- Whether they are the host superadmin, whom Doco's admin pages answer.
  superadmin      boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS users_github_login_idx ON users (github_login);

-- Password verification is deliberately expensive, so rejected sign-ins must
-- be stopped before scrypt runs. Keys are SHA-256 digests of normalized account
-- and client buckets; raw email and network identifiers are never retained.
CREATE TABLE IF NOT EXISTS password_sign_in_attempts (
  key_hash           text PRIMARY KEY,
  scope              text NOT NULL CHECK (scope IN ('account', 'client')),
  attempt_count      integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  window_started_at  timestamptz NOT NULL,
  blocked_until      timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_sign_in_attempts_updated_idx
  ON password_sign_in_attempts (updated_at);

-- A person's passkeys, each the WebAuthn credential one passkey provider
-- (iCloud Keychain, Google Password Manager, 1Password, …) keeps for them
-- (decision_01M644H6QSMTTBBFT0JAR8TEDM). The provider names itself by `aaguid`, unsigned,
-- so it is a label, never proof.
CREATE TABLE IF NOT EXISTS passkeys (
  id            text PRIMARY KEY,            -- the credential id, base64url
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key    bytea NOT NULL,              -- COSE
  counter       bigint NOT NULL DEFAULT 0,
  transports    text[] NOT NULL DEFAULT '{}',
  aaguid        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);
CREATE INDEX IF NOT EXISTS passkeys_user_idx ON passkeys (user_id);

-- A person's authenticator app, the second factor for those who don't use a
-- passkey: at most one per account, set up again in place
-- (decision_01M644H6QSMTTBBFT0JAR8TEDM, lib/totp.server.ts). `secret` is the
-- TOTP key, encrypted (lib/secret-box.server.ts). A code works once: the
-- 30-second step of the last one taken is kept, and no earlier one counts.
-- `failures` wrong codes since `failed_at` stop codes for a while
-- (decision_01M644H4Y6SAKGVX7HK0TNG65R).
CREATE TABLE IF NOT EXISTS authenticator_apps (
  user_id       text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret        text NOT NULL,
  last_step     bigint NOT NULL DEFAULT 0,
  failures      integer NOT NULL DEFAULT 0,
  failed_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);

-- The one-use codes a person saves when they set up their authenticator app.
-- Only each code's SHA-256 is kept: the plaintext is shown once, and replacing
-- or removing the app replaces or removes its codes with it.
CREATE TABLE IF NOT EXISTS authenticator_recovery_codes (
  user_id       text NOT NULL REFERENCES authenticator_apps(user_id) ON DELETE CASCADE,
  code_hash     text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, code_hash)
);

-- A sign-in waiting for the person to approve it from their phone
-- (lib/phone-approval.server.ts): the computer that just took their password
-- shows a QR code linking to `code`, and the phone approves it with one of the
-- account's passkeys. `browser` and `place` say where the sign-in comes from,
-- for the phone to show. A row lasts five minutes; the next one started clears
-- those older.
CREATE TABLE IF NOT EXISTS phone_approvals (
  code          text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  browser       text NOT NULL,
  place         text,
  approved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);


CREATE TABLE IF NOT EXISTS workspaces (
  id          text PRIMARY KEY,
  handle      text NOT NULL UNIQUE,
  name        text NOT NULL,
  -- Free-form governing charter for the workspace — the standing "how work is
  -- done here" text shared with every agent granted access to the workspace at
  -- bootstrap, and shown on the workspace home page.
  constitution text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- When its last activity digest went out (lib/activity-digest.server.ts):
  -- claimed before sending, so two runs never both send one.
  digest_sent_at timestamptz,
  -- Whose personal workspace this is. Signing up used to create one named
  -- after the person; it no longer does (decision_01M4GF757E9T2X902JZKYG0DKG),
  -- so this is set only on the ones people already had (marked once, below)
  -- and nothing writes it. It is no project's: its person walks no setup
  -- steps and gets no digest for it.
  personal_user_id text REFERENCES users(id) ON DELETE SET NULL,
  -- Whether agents end each pull request they write for this workspace with a
  -- "Briefed by Doco" line linked to their brief (the standing orders ask for
  -- it). Off unless an owner turns it on, so it never reads as spam.
  pr_brief_line boolean NOT NULL DEFAULT false,
  -- Whether anyone may read the web editions of its newspaper, The
  -- <Workspace> Times, with the stories from its public collections only.
  -- Members-only unless an owner turns it on.
  times_public boolean NOT NULL DEFAULT false
);

-- Workspace users (per-workspace role grants).
CREATE TABLE IF NOT EXISTS workspace_users (
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner', 'writer', 'reader')),
  -- Per-type write grants. '*' = write every type; owners ignore this and
  -- write everything.
  write_types   text[] NOT NULL DEFAULT ARRAY[]::text[],
  joined_at     timestamptz NOT NULL DEFAULT now(),
  -- How often the member gets the workspace's activity digest
  -- (lib/activity-digest.ts): every day unless they switched it to every
  -- Monday, or never once they unsubscribed. The email's links set it.
  digest text NOT NULL DEFAULT 'daily' CHECK (digest IN ('daily', 'weekly', 'off')),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS workspace_users_user_idx ON workspace_users (user_id);

-- Onboarding: every member of a workspace (but not of their personal one)
-- walks its getting-started steps (web lib/onboarding-steps.ts). Each step
-- reads as done from what the database already holds
-- (web lib/onboarding.server.ts); a row keeps only what nothing else records:
-- who created the workspace or joined it from an invite, and when (the
-- reminder email's clock), when the person ended the other-sources and invite
-- steps, and when the reminder went out. A member without a row walks the
-- steps by role and is never reminded.
CREATE TABLE IF NOT EXISTS workspace_onboarding (
  workspace_id     text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_as        text NOT NULL CHECK (joined_as IN ('creator', 'invitee')),
  -- What its creator answered, creating it, to whether the workspace is for a
  -- project with a GitHub repository: yes walks them through connecting GitHub
  -- after Slack. NULL when nobody was asked (someone who joined from an
  -- invite, or a creator from before the question, who walks it).
  github_repo      boolean,
  started_at       timestamptz NOT NULL DEFAULT now(),
  slack_done_at    timestamptz,
  sources_done_at  timestamptz,
  invite_done_at   timestamptz,
  reminded_at      timestamptz,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS workspace_onboarding_due_idx
  ON workspace_onboarding (started_at) WHERE reminded_at IS NULL;

-- Every collection has a single public `handle`. It lives in the same flat
-- namespace as top-level host routes. The internal ULID `id` stays as
-- the FK target for entity tables; `handle` is what URLs and public API
-- calls use.
CREATE TABLE IF NOT EXISTS collections (
  id              text PRIMARY KEY,
  handle          text NOT NULL UNIQUE,
  owner_id        text NOT NULL,    -- workspace_<ulid>
  workspace_id    text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  visibility      text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  default_node_lifecycle text,
  -- Free-form sentence the project owner writes (or the creation template
  -- seeds) to tell agents what this collection is for. Surfaced at the top of
  -- each collection's policy set in the agent-bootstrap manifest, and under
  -- the title on the collection home page.
  goal            text NOT NULL DEFAULT '',
  data            jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Soft-delete tombstone. NULL = live; a timestamp = deleted, awaiting the
  -- 30-day purge sweep (admin.purge-deleted-collections cron) that hard-deletes it
  -- via ON DELETE CASCADE. Every read path filters `deleted_at IS NULL`, so a
  -- tombstoned collection is invisible everywhere — unreachable by URL, gone from
  -- every listing — while its rows are retained for the grace window. On
  -- delete the handle is rewritten to `<handle>-deleted-<epoch-millis>`, which
  -- frees the original name for immediate reuse while keeping the tombstone's
  -- own handle unique (UNIQUE above still spans tombstoned rows).
  deleted_at      timestamptz
);

-- Collection linking is unshipped. Remove both its rows and the supporting
-- index from databases that already received the abandoned abstraction.
DROP TABLE IF EXISTS collection_edges;
DROP INDEX IF EXISTS collections_id_workspace_uniq;

-- Model-inferred relationships between collections are a derived evidence
-- index, never authored graph edges. Recomputing one collection replaces every
-- relationship that touches it; evidence retains the exact summary versions
-- and source ids admitted by the deterministic validator.
CREATE TABLE IF NOT EXISTS collection_summaries (
  collection_id         text PRIMARY KEY REFERENCES collections(id) ON DELETE CASCADE,
  workspace_id          text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_version        text NOT NULL,
  summary_version       text NOT NULL,
  relationships_version text,
  relationships_inferred_at timestamptz,
  model_id              text NOT NULL,
  digest                text NOT NULL,
  evidence_ids          text[] NOT NULL DEFAULT ARRAY[]::text[],
  summarized_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE collection_summaries
  ADD COLUMN IF NOT EXISTS relationships_inferred_at timestamptz;
CREATE INDEX IF NOT EXISTS collection_summaries_workspace_idx
  ON collection_summaries (workspace_id, summarized_at);

-- A failed summary moves behind work that has not had a chance yet. Without
-- this small durable queue marker, one slow collection is selected every
-- minute forever and prevents every later collection from being summarized.
CREATE TABLE IF NOT EXISTS collection_summary_failures (
  collection_id  text PRIMARY KEY REFERENCES collections(id) ON DELETE CASCADE,
  failed_at      timestamptz NOT NULL DEFAULT now(),
  error          text NOT NULL
);

-- A failed workspace inference follows the same queue rule as a failed
-- summary: retry it only after graphs that have not had a chance yet.
CREATE TABLE IF NOT EXISTS collection_relationship_failures (
  workspace_id  text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  failed_at     timestamptz NOT NULL DEFAULT now(),
  error         text NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_relationships (
  id                  text PRIMARY KEY,
  workspace_id        text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  from_collection_id  text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  to_collection_id    text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  relationship_type   text NOT NULL
                        CHECK (relationship_type IN
                          ('implements', 'documents', 'depends_on', 'derived_from')),
  confidence          double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence            jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'array'),
  verification_status text NOT NULL DEFAULT 'inferred'
                        CHECK (verification_status IN ('inferred', 'verified')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (from_collection_id <> to_collection_id),
  UNIQUE (workspace_id, from_collection_id, relationship_type, to_collection_id)
);
CREATE INDEX IF NOT EXISTS collection_relationships_workspace_idx
  ON collection_relationships (workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS collection_relationships_from_idx
  ON collection_relationships (from_collection_id);
CREATE INDEX IF NOT EXISTS collection_relationships_to_idx
  ON collection_relationships (to_collection_id);
UPDATE collection_summaries cs
   SET relationships_inferred_at = coalesce(
         (SELECT max(r.updated_at)
            FROM collection_relationships r
           WHERE r.workspace_id = cs.workspace_id),
         cs.summarized_at
       )
 WHERE cs.relationships_inferred_at IS NULL
   AND (cs.relationships_version IS NOT NULL OR EXISTS (
         SELECT 1 FROM collection_relationships r
          WHERE r.workspace_id = cs.workspace_id
       ));

-- Per-collection policies. Every policy is an authoring policy; the standalone
-- `kind` classifies it ('suggestion' | 'deterministic' | 'probabilistic') and
-- is mirrored to a column for filtering. The full structured record
-- (predicate, on_violation, fires_when_node_lifecycle, …) lives in `data`.

CREATE TABLE IF NOT EXISTS policies (
  id          text PRIMARY KEY,
  collection_id     text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  -- 'suggestion' | 'deterministic' | 'probabilistic'.
  kind        text,
  -- Policies only ever occupy two stages: 'active' or 'retired'.
  lifecycle   text NOT NULL DEFAULT 'active'
                CONSTRAINT policies_lifecycle_check CHECK (lifecycle IN ('active', 'retired')),
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
CREATE INDEX IF NOT EXISTS policies_collection_idx
  ON policies (collection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS policies_kind_idx
  ON policies (collection_id, kind);
CREATE INDEX IF NOT EXISTS policies_lifecycle_idx
  ON policies (collection_id, lifecycle);

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
  collection_id        text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  node_type      text NOT NULL,              -- intent|idea|rule|decision|action|log|eval|reference|state|principal
  -- Lifecycle is mandatory; canonical stages: drafting|queued|active|retired.
  lifecycle      text NOT NULL DEFAULT 'active',
  prose          text NOT NULL DEFAULT '',   -- unified label/prose for every node type, including the principal's name
  proposer_id               text CONSTRAINT nodes_proposer_fk               REFERENCES users(id) ON DELETE SET NULL,             -- idea → users(id) (OAuth identity)
  -- Promoted scalar columns. Slim-down contract phase: every per-type scalar
  -- moved into `extra` and is dropped below; `kind` is the last one
  -- (eval/state, plus principal human|agent).
  kind         text,                          -- eval, state, principal
  -- Where a node's source lives, promoted out of `extra` to its own typed
  -- column: a reference's locator, or an eval's (a test's path:line, or the
  -- GitHub issue it mirrors). The GitHub imports' idempotency lookups
  -- index it. Null for every other node type.
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
CREATE INDEX IF NOT EXISTS nodes_collection_type_idx  ON nodes (collection_id, node_type, created_at DESC);
CREATE INDEX IF NOT EXISTS nodes_collection_life_idx  ON nodes (collection_id, lifecycle);
-- Dedupe key on the promoted `locator` column — the GitHub imports'
-- idempotency lookups (a pull request's Reference, an issue's Eval) are indexed
-- reads on it.
DROP INDEX IF EXISTS nodes_ref_locator_idx;
CREATE INDEX IF NOT EXISTS nodes_locator_idx ON nodes (collection_id, locator) WHERE locator IS NOT NULL;
-- A GitHub connection has one canonical node for each imported issue or pull
-- request. The connection row lock serializes syncs; this index is the final
-- database guard against duplicate identities if a writer bypasses that path.
CREATE UNIQUE INDEX IF NOT EXISTS nodes_github_locator_unique_idx
  ON nodes (collection_id, locator)
  WHERE locator IS NOT NULL AND extra ? 'github_repository';
-- When a collection's GitHub import last wrote a pull request's Reference or an
-- issue's Eval is one probe of this index; the predicate is the import's
-- (the imported_items view).
CREATE INDEX IF NOT EXISTS nodes_github_import_idx ON nodes (collection_id, updated_at)
  WHERE node_type IN ('reference', 'eval')
    AND locator ~ '^https://github\.com/[^/]+/[^/]+/(pull|issues)/[0-9]+$';

-- Qdrant is a rebuildable search projection; PostgreSQL remains authoritative.
-- The singleton cursor keyset-backfills nodes that predate this projection.
-- The outbox then captures every committed node mutation without making an
-- authoring request depend on Qdrant availability.
CREATE TABLE IF NOT EXISTS qdrant_record_projection_state (
  singleton             boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  initialized           boolean NOT NULL DEFAULT false,
  cursor_collection_id  text,
  cursor_node_id        text,
  updated_at            timestamptz NOT NULL DEFAULT now()
);
INSERT INTO qdrant_record_projection_state (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS qdrant_record_queue (
  collection_id  text NOT NULL,
  node_id        text NOT NULL,
  operation      text NOT NULL CHECK (operation IN ('upsert', 'delete')),
  queued_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, node_id)
);
CREATE INDEX IF NOT EXISTS qdrant_record_queue_order_idx
  ON qdrant_record_queue (queued_at, collection_id, node_id);

CREATE OR REPLACE FUNCTION queue_qdrant_record_projection()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO qdrant_record_queue (collection_id, node_id, operation)
    VALUES (OLD.collection_id, OLD.id, 'delete')
    ON CONFLICT (collection_id, node_id) DO UPDATE
      SET operation = EXCLUDED.operation, queued_at = now();
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.collection_id <> NEW.collection_id THEN
    INSERT INTO qdrant_record_queue (collection_id, node_id, operation)
    VALUES (OLD.collection_id, OLD.id, 'delete')
    ON CONFLICT (collection_id, node_id) DO UPDATE
      SET operation = EXCLUDED.operation, queued_at = now();
  END IF;

  INSERT INTO qdrant_record_queue (collection_id, node_id, operation)
  VALUES (NEW.collection_id, NEW.id, 'upsert')
  ON CONFLICT (collection_id, node_id) DO UPDATE
    SET operation = EXCLUDED.operation, queued_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS nodes_qdrant_record_projection ON nodes;
CREATE TRIGGER nodes_qdrant_record_projection
AFTER INSERT OR UPDATE OR DELETE ON nodes
FOR EACH ROW EXECUTE FUNCTION queue_qdrant_record_projection();

-- Audit events: one row per mutation.

CREATE TABLE IF NOT EXISTS audit_events (
  event_id      text PRIMARY KEY,
  at            timestamptz NOT NULL,
  by_user       text,
  collection_id       text REFERENCES collections(id) ON DELETE CASCADE,
  workspace_id  text REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type   text NOT NULL,
  entity_id     text NOT NULL,
  op            text NOT NULL CHECK (op IN ('entity.create', 'entity.update', 'lifecycle.transition', 'edge.add')),
  before_json   jsonb,
  after_json    jsonb,
  reason        text
);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events (entity_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_events_collection_idx ON audit_events (collection_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_events_op_idx ON audit_events (collection_id, op, at DESC);
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
  collection_id      text REFERENCES collections(id) ON DELETE CASCADE,
  actor        text,                          -- user_<ulid>
  source       text NOT NULL DEFAULT 'api'
                 CHECK (source IN ('api','mcp','ui','slack','import','reset','system')),
  reason       text,                          -- the rich "why"
  metadata     jsonb,
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS changesets_collection_idx ON changesets (collection_id, tx_id DESC);
-- Writes by an agent over the MCP server or the API (byAgentOverApiSql), which
-- the workspace setup steps look for: a few rows beside every import's.
CREATE INDEX IF NOT EXISTS changesets_by_agent_idx ON changesets (collection_id, actor)
  WHERE source = 'mcp' OR (source = 'api' AND metadata ? 'auth');
-- A collection's writes over a period, for the days the activity rollup hasn't
-- counted yet (activity_days below).
CREATE INDEX IF NOT EXISTS changesets_recorded_idx ON changesets (collection_id, recorded_at);

-- Query log — one row per query, the read-side twin of `changesets`: who
-- (actor), how they came in (source + metadata, the same request context a
-- changeset records, so reads and writes name the same agent), and when.
-- Every agent read of a collection (MCP, REST API, Señor Doco) and every search on
-- the website is a query; opening a page on the website isn't. A search across
-- a whole workspace has no `collection_id`.
CREATE TABLE IF NOT EXISTS query_events (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  actor         text,                          -- user_<ulid>; null for a project token or anonymous reader
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  collection_id       text REFERENCES collections(id) ON DELETE CASCADE,
  source        text NOT NULL
                  CHECK (source IN ('api','mcp','ui','slack','import','reset','system')),
  metadata      jsonb
);
CREATE INDEX IF NOT EXISTS query_events_workspace_idx ON query_events (workspace_id, at DESC);
CREATE INDEX IF NOT EXISTS query_events_collection_idx ON query_events (collection_id, at DESC);
CREATE INDEX IF NOT EXISTS query_events_actor_idx ON query_events (actor, at DESC);
-- Reads by an agent over the MCP server or the API, as for changesets above.
CREATE INDEX IF NOT EXISTS query_events_by_agent_idx ON query_events (workspace_id, actor)
  WHERE source = 'mcp' OR (source = 'api' AND metadata ? 'auth');

-- Information Doco returned to an agent, and the agent's optional judgment
-- once it knows whether that information helped. One row is the whole
-- feedback loop: the original question and ranked ids are the denominator;
-- nullable feedback columns distinguish "not answered" from either answer.
CREATE TABLE IF NOT EXISTS agent_results (
  id                    text PRIMARY KEY,       -- result_<ulid>, returned to the agent
  actor                 text NOT NULL,          -- user_<ulid> whose credential asked
  tool                  text NOT NULL CHECK (tool IN ('doco_brief', 'doco_search')),
  query                 text NOT NULL,
  result_ids            text[] NOT NULL DEFAULT '{}',
  source                text NOT NULL
                          CHECK (source IN ('api','mcp','ui','slack','import','reset','system')),
  metadata              jsonb,
  context               jsonb NOT NULL DEFAULT '{}'::jsonb,
  relevant              boolean,
  better_answer_found   boolean,
  better_answer         text NOT NULL DEFAULT '',
  better_answer_source  text NOT NULL DEFAULT '',
  created_at            timestamptz NOT NULL DEFAULT now(),
  feedback_at           timestamptz,
  CHECK ((relevant IS NULL) = (better_answer_found IS NULL)),
  CHECK (better_answer_found IS TRUE OR (better_answer = '' AND better_answer_source = '')),
  CHECK (better_answer_found IS NOT TRUE OR better_answer <> '' OR better_answer_source <> '')
);
CREATE INDEX IF NOT EXISTS agent_results_actor_created_idx
  ON agent_results (actor, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_results_feedback_idx
  ON agent_results (feedback_at DESC) WHERE feedback_at IS NOT NULL;

-- The activity logs counted per UTC day (activity-log.server.ts), so the
-- Activity calendars and top lists read days instead of every row: one row per
-- day, log, collection (or, for a search across a whole workspace, no collection and the
-- workspace), person, and the agent they worked through (`via`, null for the
-- website) or, for imports, the integration, with the tokens its queries
-- searched (`tokens`, added below). An hourly cron counts each day
-- of writes and queries once, after it ends, and every day of imports again on
-- every run, since imports change in place and arrive dated in the past.
-- `activity_rollup.through` is the last day counted.
CREATE TABLE IF NOT EXISTS activity_days (
  day           date NOT NULL,
  log           text NOT NULL CHECK (log IN ('writes', 'queries', 'imports')),
  collection_id       text REFERENCES collections(id) ON DELETE CASCADE,
  workspace_id  text REFERENCES workspaces(id) ON DELETE CASCADE,
  actor         text,
  via           text,
  n             integer NOT NULL,
  last_at       timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_days_collection_idx ON activity_days (collection_id, day);
CREATE INDEX IF NOT EXISTS activity_days_workspace_idx ON activity_days (workspace_id, day)
  WHERE collection_id IS NULL;
CREATE TABLE IF NOT EXISTS activity_rollup (
  one      boolean PRIMARY KEY DEFAULT true CHECK (one),
  through  date NOT NULL
);

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
  entity_type  text NOT NULL,                 -- the edge's specific type (flows_to, supports, …), like node_versions
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
  collection_id         text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
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
-- At most one LIVE edge per (collection, from, to, type); retired duplicates ok.
-- Edge `role` is retired, so the relation type alone is the live identity — two
-- nodes are connected by at most one live edge of each type. (The role-removal
-- migration near the end of this file drops the old role-bearing index, dedups
-- any edges that collapse together, and recreates this one.)
CREATE UNIQUE INDEX IF NOT EXISTS edges_live_uniq
  ON edges (
    collection_id,
    from_id,
    to_id,
    edge_type
  ) WHERE lifecycle <> 'retired';
CREATE INDEX IF NOT EXISTS edges_collection_idx           ON edges (collection_id);
CREATE INDEX IF NOT EXISTS edges_collection_type_from_idx ON edges (collection_id, edge_type, from_id);
CREATE INDEX IF NOT EXISTS edges_collection_type_to_idx   ON edges (collection_id, edge_type, to_id);
CREATE INDEX IF NOT EXISTS edges_from_idx           ON edges (from_id);
CREATE INDEX IF NOT EXISTS edges_to_idx             ON edges (to_id);
CREATE INDEX IF NOT EXISTS edges_lifecycle_idx      ON edges (collection_id, lifecycle);

-- PageRank stored per node (decision_01M4EXESAH2XENAB3B612P8ZAR): each collection's
-- nodes ranked over its live edges, directed, and scaled so the average node
-- of the graph ranks 1, which keeps ranks of collections of different sizes
-- comparable. Briefs and search read it instead of loading every edge per
-- request. A node with no live edge has no row (rank 0). A write to a collection's
-- edges queues the collection in node_ranks_stale (append-only, so concurrent
-- writers never wait on each other); the minute sweep drains the queue and
-- recomputes each queued collection once (lib/node-ranks.server.ts).
CREATE TABLE IF NOT EXISTS node_ranks (
  node_id  text PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  rank     double precision NOT NULL
);
CREATE TABLE IF NOT EXISTS node_ranks_stale (
  collection_id  text NOT NULL
);
CREATE OR REPLACE FUNCTION node_ranks_mark_stale() RETURNS trigger AS $$
BEGIN
  INSERT INTO node_ranks_stale (collection_id) SELECT DISTINCT collection_id FROM changed_edges;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS edges_ranks_stale_insert ON edges;
CREATE TRIGGER edges_ranks_stale_insert
  AFTER INSERT ON edges REFERENCING NEW TABLE AS changed_edges
  FOR EACH STATEMENT EXECUTE FUNCTION node_ranks_mark_stale();
DROP TRIGGER IF EXISTS edges_ranks_stale_update ON edges;
CREATE TRIGGER edges_ranks_stale_update
  AFTER UPDATE ON edges REFERENCING NEW TABLE AS changed_edges
  FOR EACH STATEMENT EXECUTE FUNCTION node_ranks_mark_stale();
-- The first time, every collection with edges is stale.
INSERT INTO node_ranks_stale (collection_id)
SELECT DISTINCT collection_id FROM edges
 WHERE NOT EXISTS (SELECT 1 FROM node_ranks) AND NOT EXISTS (SELECT 1 FROM node_ranks_stale);

-- Embedding metadata: one row per chunk of an entity's text, for
-- graph entities and mirror rows alike. `source` says which table the
-- `entity_id` names (a node or policy id; a Notion page id; a Slack
-- message's "<channel>:<ts>"), so search filters by it and stopping a mirror
-- deletes its chunks in one statement. `chunk_text` is exactly what was
-- embedded and doubles as the search snippet. model_id + content_hash let the
-- embedding pass skip unchanged chunks; a model swap re-embeds rows whose
-- model_id differs. Qdrant is the one similarity engine. PostgreSQL keeps the
-- plain real array that was last written so its durable outbox can retry a
-- failed Qdrant write; it has no vector extension or similarity index.
--
-- Each collection's chunks are a partition of their own, `embeddings_<collection id>`,
-- made with the collection and dropped with it. Existing pgvector databases
-- already have their complete read index in Qdrant: preserve any pending
-- outbox vectors, discard the redundant PostgreSQL vector values, and remove
-- the extension without rewriting millions of rows.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE 'DROP FUNCTION IF EXISTS embeddings_nearest(vector, text[], text, text, integer)';
    IF to_regclass('embedding_vector_queue') IS NOT NULL THEN
      ALTER TABLE embedding_vector_queue ADD COLUMN IF NOT EXISTS source text;
      ALTER TABLE embedding_vector_queue ADD COLUMN IF NOT EXISTS model_id text;
      ALTER TABLE embedding_vector_queue ADD COLUMN IF NOT EXISTS content_hash text;
      ALTER TABLE embedding_vector_queue ADD COLUMN IF NOT EXISTS chunk_text text;
      ALTER TABLE embedding_vector_queue ADD COLUMN IF NOT EXISTS embedding real[];
      IF to_regclass('embeddings') IS NOT NULL THEN
        EXECUTE $migration$
          UPDATE embedding_vector_queue q
             SET source = e.source, model_id = e.model_id,
                 content_hash = e.content_hash, chunk_text = e.chunk_text,
                 embedding = e.embedding::real[]
            FROM embeddings e
           WHERE q.operation = 'upsert'
             AND e.collection_id = q.collection_id
             AND e.entity_id = q.entity_id
             AND e.chunk_index = q.chunk_index
        $migration$;
      END IF;
    END IF;
    IF to_regclass('embeddings') IS NOT NULL THEN
      ALTER TABLE embeddings DROP COLUMN embedding;
      ALTER TABLE embeddings ADD COLUMN embedding real[];
    END IF;
    IF to_regclass('embeddings_unpartitioned') IS NOT NULL THEN
      ALTER TABLE embeddings_unpartitioned DROP COLUMN embedding;
      ALTER TABLE embeddings_unpartitioned ADD COLUMN embedding real[];
    END IF;
    DROP EXTENSION vector;
  END IF;
END $$;
-- A database that kept every chunk in one table moves to the partitions: the
-- table steps aside here, and its rows move once the partitions exist (below).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('embeddings') AND relkind = 'r') THEN
    ALTER TABLE embeddings RENAME TO embeddings_unpartitioned;
    ALTER TABLE embeddings_unpartitioned RENAME CONSTRAINT embeddings_pkey TO embeddings_unpartitioned_pkey;
    DROP INDEX IF EXISTS embeddings_source_idx;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS embeddings (
  collection_id       text NOT NULL,
  source        text NOT NULL CHECK (source IN (
    'node','notion','slack','google_drive','retrieval_chunk','retrieval_entity','retrieval_relation'
  )),
  entity_id     text NOT NULL,
  chunk_index   int  NOT NULL DEFAULT 0,
  model_id      text NOT NULL,
  content_hash  text NOT NULL,
  chunk_text    text NOT NULL,
  -- Null only on rows that predate the Qdrant cutover; their vectors already
  -- live in Qdrant and are regenerated from chunk_text if the index is rebuilt.
  embedding     real[],
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, entity_id, chunk_index)
) PARTITION BY LIST (collection_id);
CREATE INDEX IF NOT EXISTS embeddings_source_idx ON embeddings (collection_id, source, model_id);

-- Keep existing databases' source constraint in sync with the definition
-- above. Retrieval graph rows are derived and may be rebuilt at any time.
ALTER TABLE embeddings DROP CONSTRAINT IF EXISTS embeddings_source_check;
ALTER TABLE embeddings ADD CONSTRAINT embeddings_source_check CHECK (source IN (
  'node','notion','slack','google_drive','retrieval_chunk','retrieval_entity','retrieval_relation'
));

-- A collection's partition. Created empty and then attached, which locks the parent
-- against schema changes only (CREATE TABLE ... PARTITION OF would block every
-- search until the transaction ends).
CREATE OR REPLACE FUNCTION embeddings_partition(parent regclass, collection text) RETURNS void AS $$
DECLARE
  part text := 'embeddings_' || collection;
BEGIN
  IF to_regclass(quote_ident(part)) IS NULL THEN
    EXECUTE format('CREATE TABLE %I (LIKE %s INCLUDING DEFAULTS INCLUDING CONSTRAINTS)', part, parent);
    EXECUTE format('ALTER TABLE %s ATTACH PARTITION %I FOR VALUES IN (%L)', parent, part, collection);
  END IF;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION collections_embeddings_partitions() RETURNS trigger AS $$
DECLARE
  collection text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM embeddings_partition('embeddings', id) FROM created_collections;
  ELSE
    FOR collection IN SELECT id FROM deleted_collections LOOP
      EXECUTE format('DROP TABLE IF EXISTS %I', 'embeddings_' || collection);
    END LOOP;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS collections_embeddings_partition_create ON collections;
CREATE TRIGGER collections_embeddings_partition_create
  AFTER INSERT ON collections REFERENCING NEW TABLE AS created_collections
  FOR EACH STATEMENT EXECUTE FUNCTION collections_embeddings_partitions();
DROP TRIGGER IF EXISTS collections_embeddings_partition_drop ON collections;
CREATE TRIGGER collections_embeddings_partition_drop
  AFTER DELETE ON collections REFERENCING OLD TABLE AS deleted_collections
  FOR EACH STATEMENT EXECUTE FUNCTION collections_embeddings_partitions();
DO $$ BEGIN
  PERFORM embeddings_partition('embeddings', id) FROM collections;
END $$;

DO $$ BEGIN
  IF to_regclass('embeddings_unpartitioned') IS NOT NULL THEN
    INSERT INTO embeddings
      (collection_id, source, entity_id, chunk_index, model_id, content_hash, chunk_text, embedding, updated_at)
    SELECT collection_id, source, entity_id, chunk_index, model_id, content_hash, chunk_text,
           embedding, updated_at
      FROM embeddings_unpartitioned;
    DROP TABLE embeddings_unpartitioned;
  END IF;
END $$;

-- PostgreSQL is the durable embedding store; an external vector engine is a
-- rebuildable read index. This compact outbox records only the latest work for
-- each chunk, so a Qdrant outage cannot lose a write and repeated edits do not
-- grow an unbounded queue. The mirror worker deletes a row only after Qdrant
-- acknowledges it, making retries idempotent.
CREATE TABLE IF NOT EXISTS embedding_vector_queue (
  collection_id text NOT NULL,
  entity_id      text NOT NULL,
  chunk_index    int  NOT NULL,
  operation      text NOT NULL CHECK (operation IN ('upsert','delete','delete_collection')),
  source         text,
  model_id       text,
  content_hash   text,
  chunk_text     text,
  embedding      real[],
  queued_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, entity_id, chunk_index)
);
ALTER TABLE embedding_vector_queue ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE embedding_vector_queue ADD COLUMN IF NOT EXISTS model_id text;
ALTER TABLE embedding_vector_queue ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE embedding_vector_queue ADD COLUMN IF NOT EXISTS chunk_text text;
ALTER TABLE embedding_vector_queue ADD COLUMN IF NOT EXISTS embedding real[];
CREATE INDEX IF NOT EXISTS embedding_vector_queue_order_idx
  ON embedding_vector_queue (queued_at, collection_id, entity_id, chunk_index);

CREATE OR REPLACE FUNCTION embeddings_queue_vector_sync() RETURNS trigger AS $$
BEGIN
  INSERT INTO embedding_vector_queue
    (collection_id, entity_id, chunk_index, operation, source, model_id,
     content_hash, chunk_text, embedding, queued_at)
  VALUES
    (coalesce(NEW.collection_id, OLD.collection_id),
     coalesce(NEW.entity_id, OLD.entity_id),
     coalesce(NEW.chunk_index, OLD.chunk_index),
     CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END,
     CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.source END,
     CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.model_id END,
     CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.content_hash END,
     CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.chunk_text END,
     CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.embedding END,
     now())
  ON CONFLICT (collection_id, entity_id, chunk_index) DO UPDATE SET
    operation = EXCLUDED.operation,
    source = EXCLUDED.source,
    model_id = EXCLUDED.model_id,
    content_hash = EXCLUDED.content_hash,
    chunk_text = EXCLUDED.chunk_text,
    embedding = EXCLUDED.embedding,
    queued_at = EXCLUDED.queued_at;
  RETURN coalesce(NEW, OLD);
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS embeddings_vector_queue_sync ON embeddings;
CREATE TRIGGER embeddings_vector_queue_sync
  AFTER INSERT OR UPDATE OR DELETE ON embeddings
  FOR EACH ROW EXECUTE FUNCTION embeddings_queue_vector_sync();

-- Dropping a collection drops its embedding partition as a table, so no row
-- DELETE triggers fire. Replace any pending chunk work with one scoped Qdrant
-- delete before the partition disappears.
CREATE OR REPLACE FUNCTION collections_queue_vector_delete() RETURNS trigger AS $$
BEGIN
  DELETE FROM embedding_vector_queue WHERE collection_id = OLD.id;
  INSERT INTO embedding_vector_queue
    (collection_id, entity_id, chunk_index, operation, queued_at)
  VALUES (OLD.id, '', -1, 'delete_collection', now())
  ON CONFLICT (collection_id, entity_id, chunk_index) DO UPDATE SET
    operation = EXCLUDED.operation,
    queued_at = EXCLUDED.queued_at;
  RETURN OLD;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS collections_vector_queue_delete ON collections;
CREATE TRIGGER collections_vector_queue_delete
  BEFORE DELETE ON collections
  FOR EACH ROW EXECUTE FUNCTION collections_queue_vector_delete();

-- Full-text search. Only nodes are indexed (entity_fts_nodes): the indexer
-- populates summary + body, and Slack search — the lone reader — queries the
-- generated `search_tsv` tsvector (English stemming, weighted A=summary,
-- B=body) through a GIN index for `@@` queries.

CREATE TABLE IF NOT EXISTS entity_fts_nodes (
  entity_id    text PRIMARY KEY,
  collection_id      text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  node_type  text NOT NULL,
  summary      text,
  body         text,
  search_tsv   tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(summary, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'B')
  ) STORED
);
CREATE INDEX IF NOT EXISTS entity_fts_nodes_collection_idx ON entity_fts_nodes (collection_id);
CREATE INDEX IF NOT EXISTS entity_fts_nodes_tsv_idx  ON entity_fts_nodes USING gin (search_tsv);

-- ── Retrieval graph ──────────────────────────────────────────────────────
-- Derived evidence index. Connector documents are split into chunks;
-- extracted entities are resolved across documents; mentions retain
-- provenance; relationship facts connect entities. These rows never turn
-- extracted claims into authored governance nodes or edges.
CREATE TABLE IF NOT EXISTS retrieval_documents (
  id             text PRIMARY KEY,
  collection_id  text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  source         text NOT NULL,
  external_id    text NOT NULL,
  locator        text,
  title          text,
  content_hash   text NOT NULL,
  extraction_id  text NOT NULL DEFAULT 'none',
  access_scopes  text[] NOT NULL DEFAULT ARRAY['workspace']::text[],
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (collection_id, source, external_id)
);
ALTER TABLE retrieval_documents
  ADD COLUMN IF NOT EXISTS extraction_id text NOT NULL DEFAULT 'none';
CREATE INDEX IF NOT EXISTS retrieval_documents_collection_idx
  ON retrieval_documents (collection_id);

CREATE TABLE IF NOT EXISTS retrieval_chunks (
  id             text PRIMARY KEY,
  collection_id  text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  document_id    text NOT NULL REFERENCES retrieval_documents(id) ON DELETE CASCADE,
  chunk_index    integer NOT NULL,
  text           text NOT NULL,
  breadcrumb     text,
  content_hash   text NOT NULL,
  access_scopes  text[] NOT NULL DEFAULT ARRAY['workspace']::text[],
  search_tsv     tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(breadcrumb, '')), 'A') ||
    setweight(to_tsvector('english', text), 'B')
  ) STORED,
  UNIQUE (document_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS retrieval_chunks_collection_idx
  ON retrieval_chunks (collection_id, document_id, chunk_index);
CREATE INDEX IF NOT EXISTS retrieval_chunks_access_idx
  ON retrieval_chunks USING gin (access_scopes);
CREATE INDEX IF NOT EXISTS retrieval_chunks_tsv_idx
  ON retrieval_chunks USING gin (search_tsv);

CREATE TABLE IF NOT EXISTS retrieval_entities (
  id                  text PRIMARY KEY,
  collection_id       text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  entity_type         text NOT NULL,
  name                text NOT NULL,
  normalized_name     text NOT NULL,
  aliases             text[] NOT NULL DEFAULT '{}'::text[],
  normalized_aliases  text[] NOT NULL DEFAULT '{}'::text[],
  description         text,
  search_tsv          tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', name), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED,
  UNIQUE (collection_id, entity_type, normalized_name)
);
CREATE INDEX IF NOT EXISTS retrieval_entities_collection_idx
  ON retrieval_entities (collection_id, entity_type, normalized_name);
CREATE INDEX IF NOT EXISTS retrieval_entities_aliases_idx
  ON retrieval_entities USING gin (normalized_aliases);
CREATE INDEX IF NOT EXISTS retrieval_entities_tsv_idx
  ON retrieval_entities USING gin (search_tsv);

CREATE TABLE IF NOT EXISTS retrieval_mentions (
  collection_id  text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  entity_id      text NOT NULL REFERENCES retrieval_entities(id) ON DELETE CASCADE,
  chunk_id       text NOT NULL REFERENCES retrieval_chunks(id) ON DELETE CASCADE,
  start_offset   integer NOT NULL DEFAULT -1,
  end_offset     integer,
  confidence     double precision NOT NULL DEFAULT 1,
  PRIMARY KEY (entity_id, chunk_id, start_offset)
);
CREATE INDEX IF NOT EXISTS retrieval_mentions_collection_entity_idx
  ON retrieval_mentions (collection_id, entity_id);
CREATE INDEX IF NOT EXISTS retrieval_mentions_chunk_idx
  ON retrieval_mentions (chunk_id);

CREATE TABLE IF NOT EXISTS retrieval_relations (
  id               text PRIMARY KEY,
  collection_id    text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  from_entity_id   text NOT NULL REFERENCES retrieval_entities(id) ON DELETE CASCADE,
  to_entity_id     text NOT NULL REFERENCES retrieval_entities(id) ON DELETE CASCADE,
  relation_type    text NOT NULL,
  fact             text NOT NULL,
  source_chunk_id  text NOT NULL REFERENCES retrieval_chunks(id) ON DELETE CASCADE,
  confidence       double precision NOT NULL DEFAULT 1,
  search_tsv       tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', relation_type), 'A') ||
    setweight(to_tsvector('english', fact), 'B')
  ) STORED,
  UNIQUE (source_chunk_id, from_entity_id, to_entity_id, relation_type, fact)
);
CREATE INDEX IF NOT EXISTS retrieval_relations_collection_from_idx
  ON retrieval_relations (collection_id, from_entity_id);
CREATE INDEX IF NOT EXISTS retrieval_relations_collection_to_idx
  ON retrieval_relations (collection_id, to_entity_id);
CREATE INDEX IF NOT EXISTS retrieval_relations_tsv_idx
  ON retrieval_relations USING gin (search_tsv);

-- Derived vectors follow the retrieval row that owns them. Collection
-- deletion drops the collection's embedding partition; these triggers cover
-- incremental document replacement and orphan cleanup.
CREATE OR REPLACE FUNCTION retrieval_embeddings_drop_for_row() RETURNS trigger AS $$
DECLARE embedding_source text;
BEGIN
  embedding_source := CASE TG_TABLE_NAME
    WHEN 'retrieval_chunks' THEN 'retrieval_chunk'
    WHEN 'retrieval_entities' THEN 'retrieval_entity'
    WHEN 'retrieval_relations' THEN 'retrieval_relation'
  END;
  DELETE FROM embeddings
   WHERE collection_id = OLD.collection_id
     AND source = embedding_source
     AND entity_id = OLD.id;
  RETURN OLD;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS retrieval_chunks_embeddings_drop ON retrieval_chunks;
CREATE TRIGGER retrieval_chunks_embeddings_drop
  AFTER DELETE ON retrieval_chunks FOR EACH ROW EXECUTE FUNCTION retrieval_embeddings_drop_for_row();
DROP TRIGGER IF EXISTS retrieval_entities_embeddings_drop ON retrieval_entities;
CREATE TRIGGER retrieval_entities_embeddings_drop
  AFTER DELETE ON retrieval_entities FOR EACH ROW EXECUTE FUNCTION retrieval_embeddings_drop_for_row();
DROP TRIGGER IF EXISTS retrieval_relations_embeddings_drop ON retrieval_relations;
CREATE TRIGGER retrieval_relations_embeddings_drop
  AFTER DELETE ON retrieval_relations FOR EACH ROW EXECUTE FUNCTION retrieval_embeddings_drop_for_row();

-- ── Touches ──────────────────────────────────────────────────────────────
-- What a node names: the file paths, URLs, node ids and pull request numbers
-- found in its prose and locator, one row each. A trigger keeps them, so every
-- write path (capture, changesets, the GitHub imports) fills them with no
-- caller plumbing, and the brief (web: lib/brief) reads them to find the
-- decisions, rules and pull requests that mention what an agent is about to
-- touch. Paths are stored without a leading "./" or "/"; a pull request is
-- "#<number>", whether written that way or as a github.com/…/pull/<number>
-- link; URLs lose trailing punctuation.
CREATE TABLE IF NOT EXISTS node_touches (
  node_id  text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  collection_id  text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  kind     text NOT NULL CHECK (kind IN ('path', 'url', 'node', 'pr')),
  value    text NOT NULL,
  PRIMARY KEY (node_id, kind, value)
);
CREATE INDEX IF NOT EXISTS node_touches_value_idx ON node_touches (collection_id, kind, value);

CREATE OR REPLACE FUNCTION node_touches_of(prose text, locator text)
  RETURNS TABLE (kind text, value text) AS $$
  WITH src AS (
    SELECT coalesce(prose, '') || E'\n' || coalesce(locator, '') AS t
  ),
  urls AS (
    SELECT rtrim(m[1], '.,;:') AS value
      FROM src, regexp_matches(t, '(https?://[^[:space:]<>"''\)\]]+)', 'g') AS m
  ),
  no_urls AS (
    SELECT regexp_replace(t, 'https?://[^[:space:]<>"''\)\]]+', ' ', 'g') AS t FROM src
  )
  SELECT 'url', value FROM urls
  UNION
  SELECT 'path', regexp_replace(m[1], '^(\./|/)', '')
    FROM no_urls,
         regexp_matches(t, '(?:^|[[:space:](`''"\[])((?:\./|/)?(?:[A-Za-z0-9_.@-]+/)+[A-Za-z0-9_.@-]+\.[A-Za-z0-9]{1,8})', 'g') AS m
  UNION
  SELECT 'node', m[1]
    FROM src,
         regexp_matches(t, '\m((?:intent|idea|rule|decision|action|log|eval|reference|state|principal|policy)_[0-9A-HJKMNP-TV-Z]{26})\M', 'g') AS m
  UNION
  SELECT 'pr', '#' || m[1]
    FROM no_urls, regexp_matches(t, '(?:^|[[:space:](])#([0-9]{1,7})\M', 'g') AS m
  UNION
  SELECT 'pr', '#' || m[1]
    FROM urls, regexp_matches(value, 'github\.com/[^/[:space:]]+/[^/[:space:]]+/pull/([0-9]+)') AS m
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION node_touches_refresh() RETURNS trigger AS $$
BEGIN
  DELETE FROM node_touches WHERE node_id = NEW.id;
  INSERT INTO node_touches (node_id, collection_id, kind, value)
    SELECT NEW.id, NEW.collection_id, t.kind, t.value
      FROM node_touches_of(NEW.prose, NEW.locator) AS t
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS nodes_touches_refresh ON nodes;
CREATE TRIGGER nodes_touches_refresh
  AFTER INSERT OR UPDATE OF prose, locator, collection_id ON nodes
  FOR EACH ROW EXECUTE FUNCTION node_touches_refresh();

-- Nodes written before the trigger existed get their rows once: only an
-- empty table is backfilled, so a later boot scans nothing.
INSERT INTO node_touches (node_id, collection_id, kind, value)
SELECT n.id, n.collection_id, t.kind, t.value
  FROM nodes n, node_touches_of(n.prose, n.locator) AS t
 WHERE NOT EXISTS (SELECT 1 FROM node_touches LIMIT 1)
ON CONFLICT DO NOTHING;

-- ──────────────────────────────────────────────────────────────────────────
-- Multi-level access (decision_01KS0JBJ5X0AZ4XJJFKEWE1R62).
--
-- Three roles (owner / writer / reader) granted at two levels
-- (workspace / collection). Effective role = max across levels (highest-wins
-- additive composition). Writers may add, edit, retire, and transition
-- the lifecycle of any node or edge; what they may or may not do
-- is governed by the collection's own policies, not a built-in role ladder.
-- Owners additionally administer the collection (users, tokens, policies).

-- Per-collection user grants. Invite redemption and owner/admin surfaces write
-- these rows directly; OAuth tokens authenticate callers but do not store
-- membership.
CREATE TABLE IF NOT EXISTS collection_users (
  collection_id       text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner', 'writer', 'reader')),
  -- Per-type write grants. '*' = write every type; owners ignore this and
  -- write everything.
  write_types   text[] NOT NULL DEFAULT ARRAY[]::text[],
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, user_id)
);
CREATE INDEX IF NOT EXISTS collection_users_user_idx ON collection_users (user_id);

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
-- `granted_collection_ids` is the set of collections the user approved this
-- client to access. Empty array means collection-level approval is pending
-- (rare path; we always require at least one collection today).
CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code                  text PRIMARY KEY,
  client_id             text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id               text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri          text NOT NULL,
  code_challenge        text NOT NULL,
  code_challenge_method text NOT NULL DEFAULT 'S256' CHECK (code_challenge_method = 'S256'),
  granted_collection_ids      text[] NOT NULL,
  -- Per-collection role scope-down. Map of collection_id → CollectionRole capping the
  -- token's effective role on that collection. The user can lower the role
  -- below what they themselves hold (give the agent "reader" on a collection
  -- where they're owner) but never raise it. Missing entries mean
  -- "inherit the principal's actual role" — i.e. no scope-down.
  granted_collection_roles    jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Per-type write scope-down, keyed by collection_id to a list of writable-type
  -- tokens ('*' = all). Parallels granted_collection_roles.
  granted_collection_write_types jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Workspace-level grants. When the user approves access to a workspace, every
  -- collection owned by that workspace becomes reachable through this token —
  -- including collections created under the workspace after the token was minted
  -- ("live" grant, not a snapshot). `granted_workspace_roles[workspace_id]` caps
  -- the effective role on collections under that workspace, same semantics as
  -- granted_collection_roles.
  granted_workspace_ids       text[] NOT NULL DEFAULT ARRAY[]::text[],
  granted_workspace_roles     jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_workspace_write_types jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 'actor' = the human approved an "all workspaces" credential: the minted
  -- refresh token carries NO explicit grants and resolves the user's LIVE
  -- workspace membership on every request.
  -- 'regular' (default) copies the granted_* sets above through verbatim.
  grant_type            text NOT NULL DEFAULT 'regular'
                        CHECK (grant_type IN ('regular', 'actor')),
  -- For an actor token, the role CEILING applied to every workspace: at refresh
  -- the access token gets min(your live role there, this). NULL = owner = your
  -- full live role (the original actor behavior). Ignored for 'regular'.
  actor_role            text CHECK (actor_role IS NULL OR actor_role IN ('reader','writer','owner')),
  scope                 text,
  expires_at            timestamptz NOT NULL,
  consumed_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_authorization_codes_expires_idx
  ON oauth_authorization_codes (expires_at);

-- Access tokens (~1h TTL). Opaque, server-issued, validated on every
-- MCP / API request by exact match of the presented token's SHA-256 against
-- `token`, which holds the digest and never the token itself
-- (lib/secret-box.server.ts tokenDigest), so a copy of the database signs
-- nobody in. We don't use JWTs: tokens are single-tenant (this host issues +
-- validates them) and revocation needs to be instantaneous, which JWT TTLs
-- can't guarantee.
CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  token             text PRIMARY KEY,             -- SHA-256 of the token, hex
  client_id         text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id           text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_name        text,
  granted_collection_ids  text[] NOT NULL,
  granted_collection_roles jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_collection_write_types jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_workspace_ids   text[] NOT NULL DEFAULT ARRAY[]::text[],
  granted_workspace_roles jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_workspace_write_types jsonb NOT NULL DEFAULT '{}'::jsonb,
  scope             text,
  -- An 'actor' access token carries no stored grants: it acts as `user_id`,
  -- capped at `actor_role` (null = owner = full live role), resolved live
  -- against the user's current membership on every request.
  grant_type        text NOT NULL DEFAULT 'regular'
                    CHECK (grant_type IN ('regular', 'actor')),
  actor_role        text CHECK (actor_role IS NULL OR actor_role IN ('reader','writer','owner')),
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
  token             text PRIMARY KEY,             -- SHA-256 of the token, hex
  client_id         text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id           text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_name        text,
  granted_collection_ids  text[] NOT NULL,
  granted_collection_roles jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_collection_write_types jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_workspace_ids   text[] NOT NULL DEFAULT ARRAY[]::text[],
  granted_workspace_roles jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_workspace_write_types jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 'actor' = a user-level credential whose breadth is the user's LIVE
  -- workspace membership, resolved on every request. 'regular' (default) = a
  -- refresh whose explicit grants (any set of workspaces and collections) copy
  -- through to the access token verbatim. An actor refresh carries NO
  -- explicit workspace/collection grants.
  grant_type        text NOT NULL DEFAULT 'regular'
                    CHECK (grant_type IN ('regular', 'actor')),
  -- Role CEILING for an actor refresh, applied to every workspace: at refresh
  -- the minted access token gets min(your live role there, this). NULL = owner
  -- = your full live role (the original actor behavior). Ignored for 'regular'.
  actor_role        text CHECK (actor_role IS NULL OR actor_role IN ('reader','writer','owner')),
  scope             text,
  expires_at        timestamptz NOT NULL,
  revoked           boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_user_idx ON oauth_refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_expires_idx
  ON oauth_refresh_tokens (expires_at);

-- Tokens minted before the database held digests (2026-10-28) are hashed in
-- place, once: a row still holding a token is one that starts with its
-- prefix, and a digest never does. The tokens their holders keep go on
-- working, since validation hashes what is presented.
UPDATE oauth_access_tokens
   SET token = encode(sha256(convert_to(token, 'UTF8')), 'hex')
 WHERE token LIKE 'doco\_at\_%';
UPDATE oauth_refresh_tokens
   SET token = encode(sha256(convert_to(token, 'UTF8')), 'hex')
 WHERE token LIKE 'doco\_rt\_%';

-- Device Authorization Grant (RFC 8628). Designed for agents that
-- cannot drive a localhost-redirect OAuth flow (no port-binding,
-- no browser of their own): the agent calls
-- POST /oauth/device_authorization, displays the short `user_code`
-- to the human, then polls /oauth/token until the human approves
-- in their browser at GET /device.
--
-- `status` transitions: pending → approved (user_id +
-- granted_collection_ids set) or denied or expired. The polling endpoint
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
  granted_collection_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  granted_collection_roles jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_collection_write_types jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_workspace_ids  text[] NOT NULL DEFAULT ARRAY[]::text[],
  granted_workspace_roles jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_workspace_write_types jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- See oauth_authorization_codes.grant_type — same 'regular'/'actor' meaning;
  -- the polling endpoint copies this onto the minted refresh token.
  grant_type       text NOT NULL DEFAULT 'regular'
                     CHECK (grant_type IN ('regular', 'actor')),
  -- See oauth_authorization_codes.actor_role — the role ceiling carried onto the
  -- minted refresh token. NULL = owner (full live role).
  actor_role       text CHECK (actor_role IS NULL OR actor_role IN ('reader','writer','owner')),
  target_collection_handle text,
  requested_role text CHECK (requested_role IS NULL OR requested_role IN ('reader','writer','owner')),
  expires_at       timestamptz NOT NULL,
  last_polled_at   timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_device_authorizations_user_code_idx
  ON oauth_device_authorizations (user_code);
CREATE INDEX IF NOT EXISTS oauth_device_authorizations_expires_idx
  ON oauth_device_authorizations (expires_at);

-- Access requests. Someone who can't (fully) use a collection asks its owners
-- for a role; an owner approves (writing a collection_users grant — see the
-- access engine) or denies. The PUSH counterpart to invites (which are
-- PULL: an owner mints a link). The partial unique index keeps at most
-- one live (pending) request per (collection, requester); deciding it frees a
-- new one. Connector tokens defer to the matrix, so an approved grant
-- takes effect on the requester's next call with no re-auth.
-- Access requests: someone asks the owners of a collection, or of a whole
-- workspace, for a role. Exactly one of collection_id and workspace_id is set.
-- A workspace request is how a person whose project's .doco/workspace names a
-- workspace they are not in asks to join it; approving writes workspace_users.
CREATE TABLE IF NOT EXISTS access_requests (
  id             text PRIMARY KEY,                  -- accreq_<opaque>
  collection_id  text REFERENCES collections(id) ON DELETE CASCADE,
  workspace_id   text REFERENCES workspaces(id) ON DELETE CASCADE,
  requester_id   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_role text NOT NULL CHECK (requested_role IN ('reader','writer','owner')),
  reason         text,
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','denied','cancelled')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz,
  decided_by     text REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS access_requests_collection_status_idx
  ON access_requests (collection_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS access_requests_one_pending_idx
  ON access_requests (collection_id, requester_id) WHERE status = 'pending';
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS workspace_id text REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE access_requests ALTER COLUMN collection_id DROP NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'access_requests_one_target') THEN
    ALTER TABLE access_requests ADD CONSTRAINT access_requests_one_target
      CHECK ((collection_id IS NULL) <> (workspace_id IS NULL));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS access_requests_one_pending_workspace_idx
  ON access_requests (workspace_id, requester_id) WHERE status = 'pending';

-- Who opened a workspace's imported pull requests (web lib/github-authors.server.ts):
-- each GitHub login, how many it opened, and the repository of its latest. The
-- invite step suggests the most active ones who aren't members yet, by the
-- address on their commits, looked up once (email_checked_at) and kept here.
CREATE TABLE IF NOT EXISTS github_authors (
  workspace_id     text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  login            text NOT NULL,
  repo             text NOT NULL,
  pull_requests    integer NOT NULL DEFAULT 1,
  last_at          timestamptz NOT NULL DEFAULT now(),
  name             text,
  email            text,
  email_checked_at timestamptz,
  PRIMARY KEY (workspace_id, login)
);

-- The Workspace Times as it came out: each edition's stories, ranked once by
-- a model when the digest went out (web lib/activity-digest.server.ts), so
-- its web page (/workspaces/<handle>/times/<day>) shows the same front page
-- without ranking again. Each reader sees the stories they may read.
CREATE TABLE IF NOT EXISTS times_editions (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  cadence      text NOT NULL CHECK (cadence IN ('daily', 'weekly')),
  published_at timestamptz NOT NULL,
  stories      jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (workspace_id, cadence, published_at)
);

-- Hook tokens: a person's read-only credential for one workspace, reading
-- what its maker can read there (decision_01M4C2J610DPD028P55Q8X6VG2), with
-- no expiry; revoking is the only kill switch. Any member mints their own; an
-- agent gets its person's with the MCP tool doco_hook_token and saves it in
-- .doco/hook-tokens.json, out of git, where the Doco hook reads it. `token`
-- holds the token's SHA-256 (hex), matched against the digest of the bearer
-- presented; `token_sealed` its sealed copy (lib/secret-box.server.ts), which
-- doco_hook_token reads to hand the same token out again. They were
-- project tokens (doco_pt_…) until they were named for the hook: a guarded,
-- self-removing block renames the table, its index and each token's prefix
-- on the first boot that still has project_tokens.
DO $$
BEGIN
  IF to_regclass('public.project_tokens') IS NOT NULL THEN
    ALTER TABLE project_tokens RENAME TO hook_tokens;
    ALTER INDEX project_tokens_workspace_idx RENAME TO hook_tokens_workspace_idx;
    UPDATE hook_tokens SET token = 'doco_ht_' || substr(token, 9)
     WHERE token LIKE 'doco\_pt\_%';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS hook_tokens (
  token                 text PRIMARY KEY,         -- SHA-256 of the token, hex
  token_sealed          text,                     -- the token, sealed; null for one minted before 2026-10-28
  workspace_id          text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by_user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label                 text,
  revoked               boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  last_used_at          timestamptz
);
CREATE INDEX IF NOT EXISTS hook_tokens_workspace_idx
  ON hook_tokens (workspace_id) WHERE NOT revoked;
-- Tokens minted before the database held digests (2026-10-28) are hashed in
-- place, once, with no sealed copy to read them back from: they keep reading,
-- and doco_hook_token mints its person a new one the next time it asks.
ALTER TABLE hook_tokens ADD COLUMN IF NOT EXISTS token_sealed text;
UPDATE hook_tokens
   SET token = encode(sha256(convert_to(token, 'UTF8')), 'hex')
 WHERE token LIKE 'doco\_ht\_%';

-- Generic incoming webhooks. The secret URL carries a random token; only its
-- SHA-256 digest is stored. Every delivery is an ordinary policy-checked
-- changeset, and an explicit idempotency key makes provider retries safe.
CREATE TABLE IF NOT EXISTS incoming_webhooks (
  token               text PRIMARY KEY,
  collection_id       text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  created_by_user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label               text NOT NULL,
  revoked             boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz
);
CREATE INDEX IF NOT EXISTS incoming_webhooks_collection_idx
  ON incoming_webhooks (collection_id) WHERE NOT revoked;

CREATE TABLE IF NOT EXISTS incoming_webhook_deliveries (
  webhook_token    text NOT NULL REFERENCES incoming_webhooks(token) ON DELETE CASCADE,
  idempotency_key  text NOT NULL,
  status           text NOT NULL CHECK (status IN ('processing', 'completed')),
  response         jsonb,
  received_at      timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  PRIMARY KEY (webhook_token, idempotency_key)
);

-- Operator-managed knowledge connectors for the single-workspace host. Every
-- provider has the same durable lifecycle: one encrypted credential, one
-- external source identity, one private collection, and one sync status. The
-- provider/source uniqueness is the database-level guarantee that an external
-- source can feed only one Doco workspace on a host.
CREATE TABLE IF NOT EXISTS connector_connections (
  id                    text PRIMARY KEY,
  workspace_id          text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider              text NOT NULL CHECK (provider IN ('slack','notion','google_drive')),
  source_id             text NOT NULL,
  source_name           text NOT NULL,
  credential_sealed     text,
  collection_id         text NOT NULL UNIQUE REFERENCES collections(id) ON DELETE CASCADE,
  created_by_user_id    text NOT NULL REFERENCES users(id),
  config                jsonb NOT NULL DEFAULT '{}'::jsonb,
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  last_synced_at        timestamptz,
  last_error            text,
  sync_token            text,
  sync_started_at       timestamptz,
  UNIQUE (workspace_id, provider),
  UNIQUE (provider, source_id)
);
ALTER TABLE connector_connections ADD COLUMN IF NOT EXISTS sync_token text;
ALTER TABLE connector_connections ADD COLUMN IF NOT EXISTS sync_started_at timestamptz;

-- A connector document is an ordinary Reference node, so it appears in the
-- same collections, search, API, history, and audit stream as authored
-- knowledge. This small identity ledger maps the provider's stable id to that
-- node and records which complete snapshot last saw it. A missing document is
-- retired through the normal immutable-history path instead of being deleted.
CREATE TABLE IF NOT EXISTS connector_documents (
  connection_id  text NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
  external_id    text NOT NULL,
  node_id        text NOT NULL UNIQUE REFERENCES nodes(id) ON DELETE CASCADE,
  seen_run_id    text NOT NULL,
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, external_id)
);
CREATE INDEX IF NOT EXISTS connector_documents_seen_idx
  ON connector_documents (connection_id, seen_run_id);

-- One operator-managed GitHub source for the single workspace. The personal
-- access token is encrypted with DOCO_ENCRYPTION_KEY; it is never returned by
-- list APIs or written into collection metadata. Imported issues and pull
-- requests live in dedicated collections and use the ordinary immutable
-- node/history/audit spine.
CREATE TABLE IF NOT EXISTS github_connections (
  id                           text PRIMARY KEY,
  workspace_id                 text NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  repository                   text NOT NULL,
  token_sealed                 text,
  issues_collection_id         text NOT NULL REFERENCES collections(id),
  pull_requests_collection_id  text NOT NULL REFERENCES collections(id),
  created_by_user_id           text NOT NULL REFERENCES users(id),
  active                       boolean NOT NULL DEFAULT true,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  last_synced_at               timestamptz,
  last_error                   text,
  webhook_id                   bigint,
  webhook_secret_sealed        text,
  webhook_url                  text,
  webhook_created_at           timestamptz,
  webhook_last_delivery_at     timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS github_connections_repository_idx
  ON github_connections (lower(repository));
ALTER TABLE github_connections
  ADD COLUMN IF NOT EXISTS webhook_id bigint,
  ADD COLUMN IF NOT EXISTS webhook_secret_sealed text,
  ADD COLUMN IF NOT EXISTS webhook_url text,
  ADD COLUMN IF NOT EXISTS webhook_created_at timestamptz,
  ADD COLUMN IF NOT EXISTS webhook_last_delivery_at timestamptz;

-- GitHub names every webhook request with a globally unique delivery id. This
-- ledger makes redelivery safe: a completed refresh is returned verbatim and
-- a concurrent duplicate cannot start a second full repository sync.
CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
  connection_id  text NOT NULL REFERENCES github_connections(id) ON DELETE CASCADE,
  delivery_id    text NOT NULL,
  event          text NOT NULL,
  status         text NOT NULL CHECK (status IN ('processing', 'completed')),
  response       jsonb,
  received_at    timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  PRIMARY KEY (connection_id, delivery_id)
);

-- ──────────────────────────────────────────────────────────────────────────
-- Visualization perspectives and the per-collection attachment join. Ownership is
-- tracked by `owner_handle`.
CREATE TABLE IF NOT EXISTS perspectives (
  id              text PRIMARY KEY,
  slug            text NOT NULL UNIQUE,
  kind            text NOT NULL CHECK (kind IN ('graph','list','process','org-tree','sla','glossary','pull-requests','slack','documents')),
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
-- collection, so these rows must exist for collection creation to succeed.
INSERT INTO perspectives (id, slug, kind, name, description, icon, owner_handle, is_builtin, config) VALUES
  ('perspective_graph','graph','graph','Graph','Force-directed overview of nodes and edges — the original view.','🕸️',NULL,true,'{}'::jsonb),
  ('perspective_list','list','list','List','Sortable list of nodes, with type-aware tiebreakers.','📋',NULL,true,'{"default_sort":"recent_desc"}'::jsonb),
  ('perspective_bpmn','process','process','Process','Business process modeling — swim lanes, gateways, and events. Inspired by BPMN.','🔁','torrenegra',true,'{"lane_axis":"principal"}'::jsonb),
  ('perspective_glossary','glossary','glossary','Glossary','A dictionary-style reading of the collection''s terminology — canonical headwords, definitions, senses, and aliases laid out like a printed lexicon.','📖',NULL,true,'{"headword_field":"prose","primary_entity":"reference","definition_field":"definition"}'::jsonb),
  ('perspective_org_tree','org-tree','org-tree','Org Tree','Organizational chart — Principals as members, `has_parent` edges between principals as reporting lines, with person vs AI agent shown by icon.','🏢',NULL,true,'{"agent_icon":"🤖","person_icon":"👤","root_edge":"has_parent","icon_by_member_kind":true}'::jsonb),
  ('perspective_sla','sla','sla','SLAs','Service-level agreement control plane — commitments, owners, evidence links, remedies, and review gaps.','📜',NULL,true,'{"event_logs":false,"primary_entity":"rule","evidence_sources":["eval","reference"]}'::jsonb),
  ('perspective_pull_requests','pull-requests','pull-requests','Pull requests','Imported GitHub pull requests, grouped by lifecycle — merged, open, and closed.','🔀',NULL,true,'{}'::jsonb)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS collection_perspectives (
  collection_id            text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  perspective_id     text NOT NULL REFERENCES perspectives(id) ON DELETE CASCADE,
  position           int  NOT NULL DEFAULT 0,
  is_default         boolean NOT NULL DEFAULT false,
  attached_at        timestamptz NOT NULL DEFAULT now(),
  attached_by_user   text REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (collection_id, perspective_id)
);
CREATE INDEX IF NOT EXISTS collection_perspectives_collection_idx ON collection_perspectives (collection_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS collection_perspectives_one_default
  ON collection_perspectives (collection_id) WHERE is_default;

-- In-page assistant chat.
CREATE TABLE IF NOT EXISTS chat_conversations (
  id                       text PRIMARY KEY,
  user_id                  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  archived                 boolean NOT NULL DEFAULT false,
  active_turn_started_at   timestamptz,
  active_turn_events       jsonb NOT NULL DEFAULT '[]'::jsonb,
  title                    text,
  -- The Workspace this thread is scoped to. Señor Doco hard-scopes a thread's
  -- context (collections, policies, constitution) to this Workspace — mirroring an
  -- MCP token bound to one Workspace. Nullable: pre-existing threads (and any
  -- not yet assigned) stay workspace-less and fall back to the broad,
  -- all-reachable context. ON DELETE SET NULL so deleting a Workspace
  -- unassigns its threads rather than destroying chat history.
  workspace_id             text REFERENCES workspaces(id) ON DELETE SET NULL,
  -- The collection this thread is attached to. Every in-app Señor Doco chat is
  -- bound to exactly one collection (1:1 per user — see the unique index below):
  -- opening Señor Doco while viewing a collection starts/opens that collection's chat.
  -- workspace_id is derived from this collection's workspace at creation. Nullable
  -- so pre-existing (workspace-only) threads keep working, and ON DELETE SET
  -- NULL so deleting a collection preserves the chat history rather than destroying
  -- it (the orphaned thread just loses its collection tag).
  collection_id                  text REFERENCES collections(id) ON DELETE SET NULL,
  attached_workspace_handles text[] NOT NULL DEFAULT '{}',
  attached_collection_ids        text[] NOT NULL DEFAULT '{}',
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_user_active
  ON chat_conversations (user_id, updated_at DESC) WHERE archived = false;
-- One chat per (user, collection). Enforces "a collection can only have a chat" — the
-- get-or-create path keys on this pair and un-archives rather than minting a
-- second. Partial (collection_id IS NOT NULL) so collection-less threads stay exempt.
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_conversations_user_collection
  ON chat_conversations (user_id, collection_id) WHERE collection_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS chat_messages (
  id               text PRIMARY KEY,
  conversation_id  text NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('user','assistant')),
  content          jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_created
  ON chat_messages (conversation_id, created_at);

-- An attachment belongs to the principal who uploaded it, not to a single
-- thread: the composer uploads the bytes before the turn picks which
-- conversation to run on (rolling vs. Collection-scoped), so any lookup must key on
-- the owner. Reads filter by (id, user_id); the PK covers the id set.
CREATE TABLE IF NOT EXISTS chat_attachments (
  id               text PRIMARY KEY,
  user_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename         text NOT NULL,
  mime_type        text NOT NULL,
  size_bytes       integer NOT NULL,
  content          bytea NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL DEFAULT (now() + INTERVAL '30 days')
);
CREATE INDEX IF NOT EXISTS idx_chat_attachments_expires ON chat_attachments (expires_at);

-- Telemetry. user_id / collection_id are plain text (no FK).
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
  collection_id                     text NOT NULL,
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
  -- assistant reaches at most this one workspace; null = unbound = no collection
  -- access (fail closed). This is what stops a linked user's account-wide
  -- permissions from leaking into chat.
  doco_workspace_id           text,
  -- The channel Señor Doco speaks in unasked (lib/slack-conversations.server.ts):
  -- where he introduces himself, answers every message and posts the
  -- workspace's Times, picked by the owner at install, #doco unless they pick
  -- another, and changed in the team's Slack settings. He creates it when the
  -- team has none by that name and adds the team to it. Its name only labels it.
  default_channel_id          text,
  default_channel_name        text,
  -- How often the Times goes to that channel (lib/activity-digest.ts), as
  -- workspace_users.digest is for each member's email.
  digest                      text NOT NULL DEFAULT 'daily' CHECK (digest IN ('daily', 'weekly', 'off')),
  -- Whether the team's Slack members may join its Doco workspace on their own,
  -- and as what: off, or reader or writer. On, the Times post in the channel
  -- carries a Join button, and linking a Slack account makes the person a
  -- member (web lib/slack-join.server.ts).
  member_join                 text NOT NULL DEFAULT 'off' CHECK (member_join IN ('off', 'reader', 'writer')),
  -- Whether he answers in Slack Connect channels, which another company reads
  -- too: off unless an owner turns it on.
  answer_shared               boolean NOT NULL DEFAULT false,
  data                        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, workspace_id)
);
ALTER TABLE group_chat_installations ADD COLUMN IF NOT EXISTS default_channel_id text;
ALTER TABLE group_chat_installations ADD COLUMN IF NOT EXISTS default_channel_name text;
ALTER TABLE group_chat_installations
  ADD COLUMN IF NOT EXISTS digest text NOT NULL DEFAULT 'daily'
  CHECK (digest IN ('daily', 'weekly', 'off'));
ALTER TABLE group_chat_installations
  ADD COLUMN IF NOT EXISTS member_join text NOT NULL DEFAULT 'off'
  CHECK (member_join IN ('off', 'reader', 'writer'));
ALTER TABLE group_chat_installations
  ADD COLUMN IF NOT EXISTS answer_shared boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS group_chat_channel_connections (
  id                      text PRIMARY KEY,
  provider                text NOT NULL CHECK (provider IN ('slack','google-chat','discord','other')),
  workspace_id            text NOT NULL,
  channel_id              text NOT NULL,
  channel_name            text NOT NULL DEFAULT '',
  target_level            text NOT NULL CHECK (target_level IN ('workspace','collection')),
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
-- The Slack user who approved an install is the owner who started it, signed
-- in to Doco in the browser Slack sent back to, and each install links the two
-- (lib/slack.server.ts). Teams installed before that are linked here, so
-- their installer manages Señor Doco as an owner without linking first
-- (Alexander, 2026-11-01). Every later boot finds them linked.
INSERT INTO group_chat_user_links (id, provider, workspace_id, chat_user_id, user_id)
SELECT 'gcul_' || replace(gen_random_uuid()::text, '-', ''), i.provider, i.workspace_id,
       i.installed_by_chat_user_id, i.installed_by_user_id
  FROM group_chat_installations i
 WHERE i.installed_by_chat_user_id IS NOT NULL AND i.installed_by_user_id IS NOT NULL
ON CONFLICT (provider, workspace_id, chat_user_id, user_id) DO NOTHING;
-- What Señor Doco keeps about each conversation he speaks in unasked
-- (lib/slack-conversations.server.ts): a channel, a person, by their chat
-- user id, whose direct messages with him are where he speaks to them, or a
-- thread ("<channel>/<thread ts>"). He introduces himself once in each (a
-- channel's introduction, a person's welcome, his one offer in a thread), and
-- closes a thread once what he offered there is done. A person's row also
-- holds when they last opened his Home tab, which shows what was decided
-- since (lib/slack-home.server.ts).
CREATE TABLE IF NOT EXISTS group_chat_conversations (
  provider        text NOT NULL CHECK (provider IN ('slack','google-chat','discord','other')),
  workspace_id    text NOT NULL,
  conversation_id text NOT NULL,
  introduced_at   timestamptz,
  closed_at       timestamptz,
  home_opened_at  timestamptz,
  PRIMARY KEY (provider, workspace_id, conversation_id)
);
ALTER TABLE group_chat_conversations ADD COLUMN IF NOT EXISTS home_opened_at timestamptz;
-- group_chat_channel_intros held the channels Señor Doco had spoken in, each
-- of which had his first-reply introduction: they count as introduced.
DO $$
BEGIN
  IF to_regclass('public.group_chat_channel_intros') IS NOT NULL THEN
    INSERT INTO group_chat_conversations (provider, workspace_id, conversation_id, introduced_at)
    SELECT provider, workspace_id, channel_id, introduced_at FROM group_chat_channel_intros
    ON CONFLICT DO NOTHING;
    DROP TABLE group_chat_channel_intros;
  END IF;
END $$;

-- ── Slack public-channel mirror ─────────────────────────────────────────
-- A collection can be a read-only copy of a Slack team's PUBLIC channels, kept in
-- sync. Never DMs, private channels, or Slack Connect channels shared with
-- another organization. Files are kept as links, never bytes.
--
-- Deliberately NOT `nodes`: a message deleted in Slack (or the whole copy, on
-- uninstall) must really disappear, and a Slack team runs to millions of
-- messages, while nodes are append-only, policy-checked graph knowledge. Every
-- mirror row cascades from the mirror, which cascades from BOTH its collection and
-- its Slack installation, so deleting either wipes the copy.

-- One row per mirroring collection: "this collection mirrors that Slack team".
CREATE TABLE IF NOT EXISTS group_chat_mirrors (
  collection_id          text PRIMARY KEY REFERENCES collections(id) ON DELETE CASCADE,
  installation_id  text NOT NULL UNIQUE REFERENCES group_chat_installations(id) ON DELETE CASCADE,
  -- `<team_domain>.slack.com`, for message permalinks.
  team_domain      text NOT NULL,
  -- History backfill floor: nothing older is fetched.
  history_since    timestamptz NOT NULL,
  -- Slack's API terms require the installing organization's explicit
  -- authorization to store its data; this records who gave it, and when.
  consented_by     text REFERENCES users(id) ON DELETE SET NULL,
  consented_at     timestamptz NOT NULL,
  -- Sync pacing (lib/slack-mirror-sync.server.ts). The channel list and
  -- members are refreshed hourly; each paced Slack method (history, thread
  -- replies) runs again no sooner than its *_next_at.
  channels_synced_at timestamptz,
  history_next_at  timestamptz,
  replies_next_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_chat_channels (
  collection_id          text NOT NULL REFERENCES group_chat_mirrors(collection_id) ON DELETE CASCADE,
  channel_id       text NOT NULL,                    -- Slack C…
  name             text NOT NULL,
  topic            text NOT NULL DEFAULT '',
  purpose          text NOT NULL DEFAULT '',
  archived         boolean NOT NULL DEFAULT false,
  -- The owner opted this channel out: nothing from it is copied. Kept as a row
  -- so channel discovery doesn't add it back.
  excluded         boolean NOT NULL DEFAULT false,
  -- An owner asked Señor Doco to watch for decisions here: he offers once per
  -- thread to record what it settles, or the Decision that already answers
  -- its question (lib/slack-decisions.server.ts).
  decision_offers  boolean NOT NULL DEFAULT false,
  -- NULL until the bot has joined (it only receives a channel's events, and
  -- can only read its history, as a member).
  joined_at        timestamptz,
  -- History backfill walks newest → oldest: Slack's `next_cursor`, the oldest
  -- message ts reached so far (the next page goes to the channel least far
  -- back, so all channels fill newest-first together), and done.
  history_cursor   text,
  history_oldest_ts text,
  history_done_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, channel_id)
);

CREATE TABLE IF NOT EXISTS group_chat_messages (
  collection_id      text NOT NULL,
  channel_id   text NOT NULL,
  ts           text NOT NULL,              -- Slack's message id within the channel
  thread_ts    text,                       -- the thread's root ts (set on the root too); NULL = unthreaded
  reply_count  int  NOT NULL DEFAULT 0,    -- on thread roots, as Slack reports it
  -- History backfill of a thread root's replies: Slack's `next_cursor` while
  -- paging, and done.
  replies_cursor    text,
  replies_synced_at timestamptz,
  author_id    text,                       -- Slack user (U…) or bot (B…) id
  subtype      text,                       -- NULL for an ordinary message
  text         text NOT NULL DEFAULT '',   -- raw Slack mrkdwn
  files        jsonb NOT NULL DEFAULT '[]'::jsonb,  -- name/type/size/permalink only
  -- Slack's `edited.ts`: an edit applies only if newer (events can arrive out of order).
  edited_ts    text,
  posted_at    timestamptz NOT NULL,
  embedded_hash text,                     -- md5(text) when its chunk was last embedded
  -- 'simple' (no stemming): exact-term lookups in any language; meaning-based
  -- retrieval is the embeddings' job.
  search_tsv   tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
  PRIMARY KEY (collection_id, channel_id, ts),
  FOREIGN KEY (collection_id, channel_id) REFERENCES group_chat_channels (collection_id, channel_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS group_chat_messages_thread_idx
  ON group_chat_messages (collection_id, channel_id, thread_ts, ts) WHERE thread_ts IS NOT NULL;
CREATE INDEX IF NOT EXISTS group_chat_messages_posted_idx
  ON group_chat_messages (collection_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS group_chat_messages_tsv_idx
  ON group_chat_messages USING gin (search_tsv);
ALTER TABLE group_chat_messages ADD COLUMN IF NOT EXISTS embedded_hash text;
-- What the embedding sweep still has to embed.
CREATE INDEX IF NOT EXISTS group_chat_messages_embed_pending_idx ON group_chat_messages (collection_id)
  WHERE embedded_hash IS DISTINCT FROM md5(text);

-- A mirror collection stays private: its channels are visible only to members of
-- that Slack team, never to the internet. Enforced here, not per route, so no
-- settings surface (UI, API, agent) can publish one.
-- Shared with the Notion and Google Drive mirrors below: a collection that
-- mirrors any source stays private, and only a private collection can start
-- mirroring.
CREATE OR REPLACE FUNCTION collection_mirror_stays_private() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'collections' THEN
    IF NEW.visibility <> 'private'
       AND (EXISTS (SELECT 1 FROM group_chat_mirrors WHERE collection_id = NEW.id)
            OR EXISTS (SELECT 1 FROM notion_mirrors WHERE collection_id = NEW.id)
            OR EXISTS (SELECT 1 FROM google_drive_mirrors WHERE collection_id = NEW.id)
            OR EXISTS (SELECT 1 FROM code_files WHERE collection_id = NEW.id)) THEN
      RAISE EXCEPTION 'A mirror collection must stay private.';
    END IF;
  ELSIF (SELECT visibility FROM collections WHERE id = NEW.collection_id) <> 'private' THEN
    RAISE EXCEPTION 'Only a private collection can be a mirror.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS collections_mirror_stays_private ON collections;
CREATE TRIGGER collections_mirror_stays_private
  BEFORE UPDATE OF visibility ON collections
  FOR EACH ROW EXECUTE FUNCTION collection_mirror_stays_private();
DROP TRIGGER IF EXISTS group_chat_mirrors_private_collection ON group_chat_mirrors;
CREATE TRIGGER group_chat_mirrors_private_collection
  BEFORE INSERT OR UPDATE OF collection_id ON group_chat_mirrors
  FOR EACH ROW EXECUTE FUNCTION collection_mirror_stays_private();

-- Slack people, so the mirror shows names without a users.info call per message.
CREATE TABLE IF NOT EXISTS group_chat_members (
  collection_id       text NOT NULL REFERENCES group_chat_mirrors(collection_id) ON DELETE CASCADE,
  chat_user_id  text NOT NULL,
  display_name  text NOT NULL DEFAULT '',
  real_name     text NOT NULL DEFAULT '',
  avatar_url    text,
  is_bot        boolean NOT NULL DEFAULT false,
  deactivated   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (collection_id, chat_user_id)
);

-- ── Notion mirror ─────────────────────────────────────────────────────────
-- A collection can be a read-only copy of the Notion pages and databases a
-- workspace owner shared with the collection integration, kept in sync. The same
-- rules as the Slack mirror: deliberately NOT `nodes` (a page trashed or
-- unshared in Notion must really disappear, and a workspace runs to tens of
-- thousands of pages), every row cascades from the mirror, which cascades
-- from the collection, and the collection stays private (the trigger above). Files and
-- images are kept as links, never bytes.

-- One row per mirroring collection: "this collection mirrors that Notion workspace".
CREATE TABLE IF NOT EXISTS notion_mirrors (
  collection_id              text PRIMARY KEY REFERENCES collections(id) ON DELETE CASCADE,
  -- One Notion workspace feeds one mirror.
  workspace_id         text NOT NULL UNIQUE,
  workspace_name       text NOT NULL DEFAULT '',
  workspace_icon       text,
  -- One authorization = one bot. Webhook events name the bots that can reach
  -- an entity, so this is the routing key.
  bot_id               text NOT NULL UNIQUE,
  -- Encrypted at rest (lib/secret-box.server.ts), as the Slack bot token is.
  access_token         text NOT NULL,
  refresh_token        text,
  -- The Notion user who approved the authorization (name or id).
  authorized_by        text,
  -- Who confirmed, on behalf of their organization, that collection may keep the copy.
  consented_by         text REFERENCES users(id) ON DELETE SET NULL,
  consented_at         timestamptz NOT NULL,
  -- Sync pacing (lib/notion-mirror-sync.server.ts): a discovery walk's search
  -- cursor and timestamps, the last incremental reconcile, the users listing,
  -- a rate-limit pause, the tick heartbeat (the integration status calls the
  -- copy stalled when pages are pending and this is old), the lease a running
  -- tick holds so the next cron tick skips the mirror, and when the token
  -- stopped working.
  discovery_cursor     text,
  discovery_started_at timestamptz,
  discovered_at        timestamptz,
  reconciled_at        timestamptz,
  users_cursor         text,
  users_synced_at      timestamptz,
  next_at              timestamptz,
  ticked_at            timestamptz,
  ticking_until        timestamptz,
  needs_reauth_at      timestamptz,
  -- Notion caps how many results one search walk may page through, so a
  -- capped listing is not the whole workspace: the sync then finds the rest
  -- through the pages that name them, and never treats an unlisted page as
  -- gone.
  listing_capped_at    timestamptz,
  -- The version of the content scan (lib/notion-mirror-sync.server.ts,
  -- CONTENT_SCAN) last run over the copied pages: what they link to and the
  -- children they name, read again whenever that reading changes.
  content_scan         text,
  created_at           timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE notion_mirrors ADD COLUMN IF NOT EXISTS listing_capped_at timestamptz;
ALTER TABLE notion_mirrors DROP COLUMN IF EXISTS children_scanned_at;
ALTER TABLE notion_mirrors ADD COLUMN IF NOT EXISTS content_scan text;

DROP TRIGGER IF EXISTS notion_mirrors_private_collection ON notion_mirrors;
CREATE TRIGGER notion_mirrors_private_collection
  BEFORE INSERT OR UPDATE OF collection_id ON notion_mirrors
  FOR EACH ROW EXECUTE FUNCTION collection_mirror_stays_private();

-- One row per mirrored object: a page (every database row is a page too) or a
-- data source (a database's table). Discovery and webhooks insert stubs with
-- `fetch_pending`; the sync's drain fills them. The primary key dedupes, so a
-- burst of events for one page is one fetch.
CREATE TABLE IF NOT EXISTS notion_pages (
  collection_id          text NOT NULL REFERENCES notion_mirrors(collection_id) ON DELETE CASCADE,
  page_id          text NOT NULL,                 -- Notion uuid (dashed)
  object           text NOT NULL CHECK (object IN ('page','data_source')),
  -- Page or data source uuid; NULL at a shared root, or until the page
  -- holding the block Notion keeps it in (a column, a toggle) names it.
  parent_id        text,
  parent_type      text,                          -- page | data_source | database | workspace
  title            text NOT NULL DEFAULT '',
  icon             text,
  -- https://www.notion.so/<id>: stable across renames (Notion's own url embeds the title).
  url              text NOT NULL,
  -- A row's flattened property values; a data source's schema.
  properties       jsonb NOT NULL DEFAULT '{}'::jsonb,
  markdown         text NOT NULL DEFAULT '',      -- normalized enhanced Markdown, for rendering
  plain_text       text NOT NULL DEFAULT '',      -- tags stripped; what search sees
  content_hash     text NOT NULL DEFAULT '',
  created_time     timestamptz,
  last_edited_time timestamptz,
  last_edited_by   text,
  truncated        boolean NOT NULL DEFAULT false,
  fetch_pending    boolean NOT NULL DEFAULT true,
  fetch_reason     text,                          -- discover | reconcile | webhook | schema | retry
  fetch_attempts   int  NOT NULL DEFAULT 0,
  fetch_error      text,
  query_cursor     text,                          -- a data source's row listing in progress
  seen_at          timestamptz,                   -- last time a discovery walk listed it
  synced_at        timestamptz,                   -- NULL until content has been fetched once
  embedded_hash    text,                          -- content_hash when its chunks were last embedded
  -- 'simple' (no stemming): exact-term lookups in any language, as for Slack.
  search_tsv       tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', title), 'A') ||
    to_tsvector('simple', left(plain_text, 500000))
  ) STORED,
  PRIMARY KEY (collection_id, page_id)
);
CREATE INDEX IF NOT EXISTS notion_pages_parent_idx  ON notion_pages (collection_id, parent_id);
-- A block was once kept as a page's parent, which no page in the copy is, so
-- the page sat at the top of the tree. The page holding the block places it
-- instead (the sync's content scan reads every page again for that). Only a
-- block-parented row matches, so a reboot changes nothing.
UPDATE notion_pages SET parent_id = NULL, parent_type = NULL WHERE parent_type = 'block';
CREATE INDEX IF NOT EXISTS notion_pages_pending_idx
  ON notion_pages (collection_id, fetch_attempts, page_id) WHERE fetch_pending;
CREATE INDEX IF NOT EXISTS notion_pages_edited_idx  ON notion_pages (collection_id, last_edited_time DESC);
CREATE INDEX IF NOT EXISTS notion_pages_tsv_idx     ON notion_pages USING gin (search_tsv);
ALTER TABLE notion_pages ADD COLUMN IF NOT EXISTS embedded_hash text;
-- What the embedding sweep still has to embed.
CREATE INDEX IF NOT EXISTS notion_pages_embed_pending_idx ON notion_pages (collection_id)
  WHERE synced_at IS NOT NULL AND embedded_hash IS DISTINCT FROM content_hash;

-- Page-to-page links found in a page's Markdown (<page>, <mention-page>,
-- <database> tags and notion.so links).
CREATE TABLE IF NOT EXISTS notion_links (
  collection_id       text NOT NULL,
  from_page_id  text NOT NULL,
  to_page_id    text NOT NULL,
  PRIMARY KEY (collection_id, from_page_id, to_page_id),
  FOREIGN KEY (collection_id, from_page_id) REFERENCES notion_pages (collection_id, page_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS notion_links_to_idx ON notion_links (collection_id, to_page_id);

-- Notion people, so pages show editor names without a users call per page.
CREATE TABLE IF NOT EXISTS notion_users (
  collection_id      text NOT NULL REFERENCES notion_mirrors(collection_id) ON DELETE CASCADE,
  user_id      text NOT NULL,
  name         text NOT NULL DEFAULT '',
  avatar_url   text,
  is_bot       boolean NOT NULL DEFAULT false,
  PRIMARY KEY (collection_id, user_id)
);

-- ── Google Drive mirror ───────────────────────────────────────────────────
-- A collection can be a read-only copy of a company's Google Drive, kept in
-- sync: every file in every person's My Drive and in every shared drive that
-- Drive already lets the whole company open (shared with the company, or with
-- anyone who has the link). A file shared only with some people stays out, so
-- the copy never shows anyone a file Drive would hide from them. The same rules
-- as the Slack and Notion mirrors: deliberately NOT `nodes` (a file deleted or
-- made private in Drive must really disappear, and a company's Drive runs to
-- hundreds of thousands of files), every row cascades from the mirror, which
-- cascades from the collection, and the collection stays private
-- (collection_mirror_stays_private). Only rendered text is kept, never a
-- file's bytes.

-- The mirror used to read one person's Drive with their own OAuth grant
-- (account_email, its tokens, one changes feed). That copy can't become the
-- company's, so it goes: deleting its rows drops their embeddings, then the
-- tables are made again below in the company's shape, and so are the views
-- that read its files.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'google_drive_mirrors'
       AND column_name = 'refresh_token'
  ) THEN
    DELETE FROM google_drive_mirrors;
    DROP VIEW IF EXISTS imported_items, retrieval_source_documents;
    DROP TABLE google_drive_links, google_drive_files, google_drive_roots, google_drive_mirrors;
  END IF;
END $$;

-- One row per mirroring collection: "this collection mirrors that company's
-- Drive". A Workspace admin of the company granted Doco's service account
-- domain-wide, read-only access (lib/google-api.server.ts), then signed in
-- with Google so Doco could check they are an admin of the domain.
CREATE TABLE IF NOT EXISTS google_drive_mirrors (
  collection_id      text PRIMARY KEY REFERENCES collections(id) ON DELETE CASCADE,
  -- The company's Google Workspace domain: a file shared with it is copied.
  domain             text NOT NULL,
  -- The admin who bound the company: Doco lists its people and shared drives
  -- as them.
  admin_email        text NOT NULL,
  -- Who confirmed, on behalf of their organization, that the collection may
  -- keep the copy.
  consented_by       text REFERENCES users(id) ON DELETE SET NULL,
  consented_at       timestamptz NOT NULL,
  -- Sync pacing (lib/google-drive-mirror-sync.server.ts): a rate-limit pause,
  -- the tick heartbeat (the integration status calls the copy stalled when
  -- files are pending and this is old), the lease a running tick holds so the
  -- next cron tick skips the mirror, when the company's people and shared
  -- drives were last listed, and when Google stopped honoring the grant.
  next_at            timestamptz,
  ticked_at          timestamptz,
  ticking_until      timestamptz,
  roots_listed_at    timestamptz,
  needs_reauth_at    timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS google_drive_mirrors_private_collection ON google_drive_mirrors;
CREATE TRIGGER google_drive_mirrors_private_collection
  BEFORE INSERT OR UPDATE OF collection_id ON google_drive_mirrors
  FOR EACH ROW EXECUTE FUNCTION collection_mirror_stays_private();

-- Whose files the mirror copies (lib/google-drive-roots.server.ts): each
-- person's My Drive and each shared drive, listed again hourly, so someone
-- who joins or leaves, or a drive made or deleted, follows. A file has one
-- root, its owner's or its drive's; a root's files go with it.
CREATE TABLE IF NOT EXISTS google_drive_roots (
  collection_id         text NOT NULL REFERENCES google_drive_mirrors(collection_id) ON DELETE CASCADE,
  -- A person's primary email, or a shared drive's id.
  root_id               text NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('person', 'drive')),
  -- The person's full name, or the drive's.
  name                  text NOT NULL,
  -- Who Doco reads the root as: the person, or a member of the drive.
  reads_as              text NOT NULL,
  -- The root's changes feed: where the next read starts, taken as its walk
  -- starts so nothing after it is missed (NULL until then), and when it was
  -- last read to its end: the feeds read least lately go first.
  change_page_token     text,
  changes_read_at       timestamptz,
  -- The walk that lists the root's files, a page per request: where it is,
  -- when it started (rows it didn't see since then are gone from Drive or
  -- made private) and when it last finished. A new root has neither, so the
  -- sync walks it.
  discovery_cursor      text,
  discovery_started_at  timestamptz,
  discovered_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, root_id)
);

-- One row per file or folder the company can open, under its root
-- (lib/google-drive-mirror-sync.server.ts). A walk or the changes feed
-- inserts it with its listing metadata and flags it for a fetch when Drive's
-- `version` moved; the drain renders it (lib/google-drive-render.ts). A
-- folder, or a file with no text to copy, is done at listing.
CREATE TABLE IF NOT EXISTS google_drive_files (
  collection_id   text NOT NULL,
  file_id         text NOT NULL,
  -- The root it was found under: removing the root removes it.
  root_id         text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('doc','sheet','slides','text','folder','other')),
  mime_type       text NOT NULL,
  name            text NOT NULL DEFAULT '',
  -- The folder it sits in, or the shared drive at a drive's top level.
  parent_id       text,
  drive_id        text,                          -- its shared drive; NULL in My Drive
  web_view_link   text NOT NULL DEFAULT '',
  modified_time   timestamptz,
  modified_by     text NOT NULL DEFAULT '',      -- the last modifying user's name
  version         text,                          -- Drive's; it moves on every change
  size            bigint,                        -- bytes; NULL for Google's own documents
  markdown        text NOT NULL DEFAULT '',      -- rendered, for the reader
  plain_text      text NOT NULL DEFAULT '',      -- what search sees
  content_hash    text NOT NULL DEFAULT '',
  -- A spreadsheet with more rows or columns than are copied.
  truncated       boolean NOT NULL DEFAULT false,
  -- Why a file that could be copied as text has none: Google's export
  -- limit, or the text-file cap.
  omitted         text CHECK (omitted IN ('too_large')),
  fetch_pending   boolean NOT NULL DEFAULT false,
  fetch_attempts  int  NOT NULL DEFAULT 0,
  fetch_error     text,
  seen_at         timestamptz,                   -- last listed by a walk or the changes feed
  synced_at       timestamptz,                   -- NULL until rendered once
  embedded_hash   text,                          -- content_hash when its chunks were last embedded
  -- 'simple' (no stemming): exact-term lookups in any language, as for Notion.
  search_tsv      tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', name), 'A') ||
    to_tsvector('simple', left(plain_text, 500000))
  ) STORED,
  PRIMARY KEY (collection_id, file_id),
  FOREIGN KEY (collection_id, root_id)
    REFERENCES google_drive_roots (collection_id, root_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS google_drive_files_parent_idx
  ON google_drive_files (collection_id, parent_id);
CREATE INDEX IF NOT EXISTS google_drive_files_root_idx
  ON google_drive_files (collection_id, root_id);
CREATE INDEX IF NOT EXISTS google_drive_files_pending_idx
  ON google_drive_files (collection_id, fetch_attempts, modified_time DESC) WHERE fetch_pending;
CREATE INDEX IF NOT EXISTS google_drive_files_modified_idx
  ON google_drive_files (collection_id, modified_time DESC);
CREATE INDEX IF NOT EXISTS google_drive_files_tsv_idx ON google_drive_files USING gin (search_tsv);
-- What the embedding sweep still has to embed.
CREATE INDEX IF NOT EXISTS google_drive_files_embed_pending_idx ON google_drive_files (collection_id)
  WHERE synced_at IS NOT NULL AND embedded_hash IS DISTINCT FROM content_hash;

-- Links from one copied file's text to another Drive file (docs.google.com
-- and drive.google.com links), for the reader's links and backlinks.
CREATE TABLE IF NOT EXISTS google_drive_links (
  collection_id  text NOT NULL,
  from_file_id   text NOT NULL,
  to_file_id     text NOT NULL,
  PRIMARY KEY (collection_id, from_file_id, to_file_id),
  FOREIGN KEY (collection_id, from_file_id)
    REFERENCES google_drive_files (collection_id, file_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS google_drive_links_to_idx ON google_drive_links (collection_id, to_file_id);

-- ── Codebase copy ─────────────────────────────────────────────────────────
-- A codebase collection holds a copy of every file on the default branch of the
-- GitHub repositories it brings from (github-imports), kept in sync on every
-- push and searchable. Like the mirrors: not `nodes` (a file deleted in the
-- repository must really disappear), every row cascades from the collection, and
-- the collection stays private (collection_mirror_stays_private). One row per file; a
-- binary, oversized or unfetchable file keeps its row with `omitted` saying
-- why and no content, so paths still resolve and search by name.
CREATE TABLE IF NOT EXISTS code_files (
  collection_id    text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  repo       text NOT NULL,                       -- "owner/name"
  path       text NOT NULL,
  sha        text NOT NULL,                       -- the git blob sha: unchanged files are skipped
  size       int  NOT NULL,
  content    text NOT NULL DEFAULT '',
  omitted    text CHECK (omitted IN ('binary','too_large','unavailable')),
  synced_at  timestamptz NOT NULL DEFAULT now(),
  -- 'simple' (no stemming): identifiers and paths match as written.
  search_tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', path), 'A') || to_tsvector('simple', content)
  ) STORED,
  PRIMARY KEY (collection_id, repo, path)
);
CREATE INDEX IF NOT EXISTS code_files_repo_idx ON code_files (repo);
-- When a codebase last copied a file is one probe of this index.
CREATE INDEX IF NOT EXISTS code_files_synced_idx ON code_files (collection_id, synced_at);
CREATE INDEX IF NOT EXISTS code_files_tsv_idx  ON code_files USING gin (search_tsv);
DROP TRIGGER IF EXISTS code_files_private_collection ON code_files;
CREATE TRIGGER code_files_private_collection
  BEFORE INSERT OR UPDATE OF collection_id ON code_files
  FOR EACH ROW EXECUTE FUNCTION collection_mirror_stays_private();

-- The copy follows the connections: a collection holds a repository's files only
-- while it brings that repository, by a repo connection or by a subscription
-- to the installation of the repository's owner. Checked on every write of
-- files, and a change to the connections drops the files they no longer
-- cover, whichever code path made it.
CREATE OR REPLACE FUNCTION code_repo_connected(gh jsonb, repo text) RETURNS boolean AS $$
  SELECT EXISTS (
           SELECT 1
             FROM jsonb_array_elements(CASE jsonb_typeof(gh->'connections')
                                       WHEN 'array' THEN gh->'connections' ELSE '[]' END) AS c
            WHERE c->>'repo' = repo)
      OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements(CASE jsonb_typeof(gh->'installations')
                                       WHEN 'array' THEN gh->'installations' ELSE '[]' END) AS i
            WHERE lower(i->>'account') = lower(split_part(repo, '/', 1)))
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION code_files_follow_connections() RETURNS trigger AS $$
BEGIN
  DELETE FROM code_files
   WHERE collection_id = NEW.id
     AND NOT code_repo_connected(NEW.data->'github_integration', repo);
  DELETE FROM retrieval_documents
   WHERE collection_id = NEW.id
     AND source = 'code_graph'
     AND (external_id = '__repositories__'
       OR NOT code_repo_connected(NEW.data->'github_integration', external_id));
  DELETE FROM retrieval_entities e
   WHERE e.collection_id = NEW.id
     AND NOT EXISTS (SELECT 1 FROM retrieval_mentions m WHERE m.entity_id = e.id)
     AND NOT EXISTS (
       SELECT 1 FROM retrieval_relations r
        WHERE r.from_entity_id = e.id OR r.to_entity_id = e.id
     );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS collections_code_files_follow_connections ON collections;
CREATE TRIGGER collections_code_files_follow_connections
  AFTER UPDATE OF data ON collections
  FOR EACH ROW
  WHEN (OLD.data->'github_integration'->'connections'
          IS DISTINCT FROM NEW.data->'github_integration'->'connections'
     OR OLD.data->'github_integration'->'installations'
          IS DISTINCT FROM NEW.data->'github_integration'->'installations')
  EXECUTE FUNCTION code_files_follow_connections();

-- Issues from GitHub fill a GitHub issues collection of their own (template
-- `github-issues`), never the Bug tracker people file bugs in. A Bug tracker
-- the GitHub setup connected while bugs landed there would otherwise fall back
-- to bringing pull requests, so it loses its GitHub connection; running the
-- setup again brings the issues into a GitHub issues collection. Only a Bug tracker
-- still holding a connection matches, so a reboot changes nothing.
UPDATE collections
   SET data = data - 'github_integration'
 WHERE data->>'template_handle' = 'bugs'
   AND data ? 'github_integration';

-- GitHub brings issues, not bugs (decision_01M4GFJ3A5R9ASCBA6CWKDKSH3): a
-- GitHub bugs collection (template `github-bugs`, which brought only the issues
-- labeled bug) becomes a GitHub issues collection. The setup's
-- `<workspace>-github-bugs` handle becomes `<workspace>-github-issues` when
-- that handle is free and fits in 64 characters; a goal still the template's
-- takes the new template's; and a collection connected to repositories imports them
-- again (a running marker with no queue, which the backfill sweep resumes from
-- its connections), now bringing every issue. Only a `github-bugs` collection
-- matches, so a reboot changes nothing.
WITH bugs_collections AS (
  SELECT d.id,
         CASE
           WHEN d.handle LIKE '%-github-bugs'
            AND length(d.handle) + 2 <= 64
            AND NOT EXISTS (
                  SELECT 1 FROM collections o
                   WHERE o.handle = left(d.handle, -length('-github-bugs')) || '-github-issues')
           THEN left(d.handle, -length('-github-bugs')) || '-github-issues'
           ELSE d.handle
         END AS handle,
         jsonb_array_length(
           COALESCE(d.data->'github_integration'->'connections', '[]'::jsonb)
         ) > 0 AS connected
    FROM collections d
   WHERE d.data->>'template_handle' = 'github-bugs'
)
UPDATE collections d
   SET handle = b.handle,
       data = jsonb_set(d.data, '{template_handle}', '"github-issues"')
              || jsonb_build_object('handle', b.handle)
              || CASE WHEN b.connected
                   THEN jsonb_build_object(
                          'github_integration',
                          d.data->'github_integration'
                            || jsonb_build_object(
                                 'backfill',
                                 jsonb_build_object('status', 'running', 'started_at', now())))
                   ELSE '{}'::jsonb
                 END,
       goal = CASE
                WHEN d.goal = 'Track a GitHub repository''s bugs — issues labeled bug, or of the Bug issue type, sync automatically, and closed issues retire.'
                THEN 'Track a GitHub repository''s issues — every issue syncs automatically, and closed issues retire.'
                ELSE d.goal
              END,
       updated_at = now()
  FROM bugs_collections b
 WHERE d.id = b.id;

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
  client_context        jsonb NOT NULL DEFAULT '{}'::jsonb,
  server_context        jsonb NOT NULL DEFAULT '{}'::jsonb,
  data                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  reviewed_at           timestamptz,
  reviewed_by           text REFERENCES users(id) ON DELETE SET NULL
);
-- A report names its reporter through created_by, as they are called now; the
-- copy of their username it kept went stale once usernames could change
-- (decision_01M64TCVNSDZ5PMD080R5T33HK).
ALTER TABLE feedback_reports DROP COLUMN IF EXISTS created_by_username;
-- A report names the build it was sent from as client_context.app.release, the
-- build stamp itself. Reports sent while the header read "Alpha <sha>" kept the
-- words they scraped from it as app.alpha_text; the header now names the
-- private beta (Alexander, 2026-11-04), so those carry over to app.release.
UPDATE feedback_reports
   SET client_context = CASE
         WHEN jsonb_typeof(client_context #> '{app,alpha_text}') = 'string'
         THEN jsonb_set(client_context #- '{app,alpha_text}', '{app,release}',
                        to_jsonb(regexp_replace(client_context #>> '{app,alpha_text}', '^Alpha\s+', '')))
         ELSE client_context #- '{app,alpha_text}'
       END
 WHERE client_context #> '{app,alpha_text}' IS NOT NULL;

-- ──────────────────────────────────────────────────────────────────────────
-- Append-only guardrails. The commit log + version snapshots are
-- immutable: block UPDATE / DELETE / TRUNCATE on them at the DB level, for
-- EVERY role including superuser — stronger than REVOKE, which superusers
-- bypass. Inserts are allowed; "removal" is a retire VERSION, never a delete.
-- Idempotent (CREATE OR REPLACE + DROP IF EXISTS), so it re-asserts on every
-- cold start.
CREATE OR REPLACE FUNCTION doco_allow_history_delete_for_collection() RETURNS trigger AS $$
BEGIN
  PERFORM set_config('doco.allow_history_delete', 'on', true);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS collections_allow_history_delete ON collections;
CREATE TRIGGER collections_allow_history_delete
  BEFORE DELETE ON collections
  FOR EACH ROW
  EXECUTE FUNCTION doco_allow_history_delete_for_collection();

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

-- ──────────────────────────────────────────────────────────────────────────
-- Column backfills. A column added inline to a `CREATE TABLE IF NOT EXISTS`
-- above does NOT alter a table that already exists — the CREATE is a no-op on
-- re-boot — so a column introduced after a table first shipped must be added
-- explicitly here. Idempotent (ADD COLUMN IF NOT EXISTS), re-asserted on every
-- cold start; a no-op once the column is present (incl. on a fresh DB, where
-- the CREATE TABLE already made it). The CHECK matches the inline definition.
-- Soft-delete tombstone for collections created before the column shipped. The
-- partial sweeper index lives HERE, after the ADD COLUMN — not in the collections
-- table block above — because schema.sql re-applies top-to-bottom after every
-- change: on a pre-existing collections table the inline CREATE TABLE is a no-op, so an
-- index that referenced `deleted_at` earlier in the file would hit a column
-- that this migration hasn't added yet and abort the entire schema-apply.
ALTER TABLE collections
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS pr_brief_line boolean NOT NULL DEFAULT false;
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS times_public boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS collections_deleted_at_idx ON collections (deleted_at) WHERE deleted_at IS NOT NULL;

-- ── Unified retrieval sources ─────────────────────────────────────────────
-- Every durable knowledge source exposes one connector-neutral document
-- shape. The retrieval index consumes this view; connector fetchers remain
-- responsible only for keeping their source tables current. A new connector
-- joins retrieval by adding one branch here, not by growing another indexing
-- pipeline. This belongs after the column backfills because old databases do
-- not have collections.deleted_at until the statement immediately above.
CREATE OR REPLACE VIEW retrieval_source_documents AS
SELECT n.collection_id,
       'node'::text AS source,
       n.id AS external_id,
       n.locator,
       n.node_type AS title,
       CASE WHEN btrim(n.prose) <> '' THEN n.prose
            ELSE concat_ws(' — ', nullif(n.locator, ''), nullif(n.extra->>'name', ''),
                                  nullif(n.extra->>'verb', '')) END AS content,
       ARRAY['workspace']::text[] AS access_scopes,
       n.updated_at AS source_updated_at
  FROM nodes n
  JOIN collections c ON c.id = n.collection_id AND c.deleted_at IS NULL
 WHERE n.lifecycle <> 'retired'
   AND btrim(CASE WHEN btrim(n.prose) <> '' THEN n.prose
                  ELSE concat_ws(' — ', nullif(n.locator, ''), nullif(n.extra->>'name', ''),
                                        nullif(n.extra->>'verb', '')) END) <> ''
UNION ALL
SELECT p.collection_id,
       'notion'::text,
       p.page_id,
       p.url,
       nullif(p.title, ''),
       CASE WHEN btrim(p.markdown) <> '' THEN p.markdown ELSE p.title END,
       ARRAY['workspace']::text[],
       p.last_edited_time
  FROM notion_pages p
  JOIN collections c ON c.id = p.collection_id AND c.deleted_at IS NULL
 WHERE p.synced_at IS NOT NULL
   AND btrim(concat_ws(E'\n\n', nullif(p.title, ''), nullif(p.markdown, ''))) <> ''
UNION ALL
SELECT m.collection_id,
       'slack'::text,
       m.channel_id || ':' || m.ts,
       'https://' || mirror.team_domain || '.slack.com/archives/' || m.channel_id || '/p' ||
         replace(m.ts, '.', ''),
       '#' || ch.name,
       coalesce(nullif(member.display_name, ''), nullif(member.real_name, ''), m.author_id, 'unknown') ||
         ': ' || concat_ws(' ', nullif(m.text, ''), files.names),
       ARRAY['workspace']::text[],
       coalesce(to_timestamp(nullif(m.edited_ts, '')::numeric), m.posted_at)
  FROM group_chat_messages m
  JOIN group_chat_channels ch
    ON ch.collection_id = m.collection_id AND ch.channel_id = m.channel_id AND NOT ch.excluded
  JOIN group_chat_mirrors mirror ON mirror.collection_id = m.collection_id
  JOIN collections c ON c.id = m.collection_id AND c.deleted_at IS NULL
  LEFT JOIN group_chat_members member
    ON member.collection_id = m.collection_id AND member.chat_user_id = m.author_id
  LEFT JOIN LATERAL (
    SELECT string_agg(nullif(file->>'name', ''), ' ') AS names
      FROM jsonb_array_elements(m.files) AS file
  ) files ON true
 WHERE btrim(concat_ws(' ', nullif(m.text, ''), files.names)) <> ''
UNION ALL
SELECT f.collection_id,
       'google_drive'::text,
       f.file_id,
       f.web_view_link,
       nullif(f.name, ''),
       CASE WHEN btrim(f.markdown) <> '' THEN f.markdown ELSE f.name END,
       ARRAY['workspace']::text[],
       f.modified_time
  FROM google_drive_files f
  JOIN collections c ON c.id = f.collection_id AND c.deleted_at IS NULL
 WHERE f.synced_at IS NOT NULL AND f.kind <> 'folder'
   AND btrim(concat_ws(E'\n\n', nullif(f.name, ''), nullif(f.markdown, ''))) <> ''
UNION ALL
SELECT f.collection_id,
       'code'::text,
       f.repo || ':' || f.path,
       'https://github.com/' || f.repo || '/blob/HEAD/' || f.path,
       f.repo || '/' || f.path,
       CASE WHEN btrim(f.content) <> '' THEN f.content ELSE f.path END,
       ARRAY['workspace']::text[],
       f.synced_at
  FROM code_files f
  JOIN collections c ON c.id = f.collection_id AND c.deleted_at IS NULL;

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS digest_sent_at timestamptz;
-- Mark the personal workspaces people already have with whose they are: the
-- ones named after a person's GitHub login, which is how they were recognized
-- before (decision_01M4GF7HA9NQ6ZX1E9M4G8S2DG). Runs once, on the boot that
-- adds the column, so a workspace someone later names after themselves stays
-- an ordinary one.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'workspaces'
       AND column_name = 'personal_user_id'
  ) THEN
    ALTER TABLE workspaces
      ADD COLUMN personal_user_id text REFERENCES users(id) ON DELETE SET NULL;
    UPDATE workspaces w
       SET personal_user_id = u.id
      FROM users u
     WHERE lower(u.github_login) = lower(w.handle);
  END IF;
END $$;
ALTER TABLE workspace_users
  ADD COLUMN IF NOT EXISTS digest text NOT NULL DEFAULT 'daily'
  CHECK (digest IN ('daily', 'weekly', 'off'));
-- `digest` replaced digest_unsubscribed_at, when the digest was daily only
-- during a workspace's first week: everyone now gets it daily, and whoever had
-- unsubscribed stays unsubscribed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'workspace_users'
       AND column_name = 'digest_unsubscribed_at'
  ) THEN
    UPDATE workspace_users SET digest = 'off' WHERE digest_unsubscribed_at IS NOT NULL;
    ALTER TABLE workspace_users DROP COLUMN digest_unsubscribed_at;
  END IF;
END $$;
-- Every agent Doco supports runs hooks, so nobody skips the hook any more.
ALTER TABLE workspace_onboarding DROP COLUMN IF EXISTS hook_done_at;
-- When an owner ended (or skipped) inviting their colleagues
-- (decision_01M4NJQXQZXFA74A7MCSYY9B6S).
ALTER TABLE workspace_onboarding ADD COLUMN IF NOT EXISTS invite_done_at timestamptz;
-- Connecting Slack became a workspace's first step, ended by connecting a team
-- or skipping it, and connecting GitHub a step only for a workspace its
-- creator said is for a project with a GitHub repository (Alexander,
-- 2026-10-30).
ALTER TABLE workspace_onboarding ADD COLUMN IF NOT EXISTS slack_done_at timestamptz;
ALTER TABLE workspace_onboarding ADD COLUMN IF NOT EXISTS github_repo boolean;
-- Inviting colleagues became an owner's last step when it shipped on
-- 2026-10-17, done only once they end or skip it
-- (decision_01M4TGN2D498GD9FXS7R3M5KH9). Until then it read as done once any
-- agent worked in the workspace, so it is ended for every owner it read as
-- done for then: an owner who had joined a workspace agents had read or
-- written in by then. A workspace already set up never shows its steps
-- again, and only members and work from before the move match, so a reboot
-- changes nothing.
INSERT INTO workspace_onboarding (workspace_id, user_id, joined_as, invite_done_at, reminded_at)
SELECT wu.workspace_id, wu.user_id, 'creator', now(), now()
  FROM workspace_users wu
 WHERE wu.role = 'owner'
   AND wu.joined_at < '2026-10-17T12:30:00Z'
   AND (EXISTS (
          SELECT 1 FROM changesets cs
            JOIN collections d ON d.id = cs.collection_id
           WHERE d.workspace_id = wu.workspace_id
             AND cs.recorded_at < '2026-10-17T12:30:00Z'
             AND (cs.source = 'mcp' OR (cs.source = 'api' AND cs.metadata ? 'auth')))
        OR EXISTS (
          SELECT 1 FROM query_events q
           WHERE q.workspace_id = wu.workspace_id
             AND q.at < '2026-10-17T12:30:00Z'
             AND (q.source = 'mcp' OR (q.source = 'api' AND q.metadata ? 'auth'))))
ON CONFLICT (workspace_id, user_id) DO UPDATE
  SET invite_done_at = COALESCE(workspace_onboarding.invite_done_at, now());

ALTER TABLE oauth_authorization_codes
  ADD COLUMN IF NOT EXISTS actor_role text
  CHECK (actor_role IS NULL OR actor_role IN ('reader','writer','owner'));
ALTER TABLE oauth_refresh_tokens
  ADD COLUMN IF NOT EXISTS actor_role text
  CHECK (actor_role IS NULL OR actor_role IN ('reader','writer','owner'));
ALTER TABLE oauth_device_authorizations
  ADD COLUMN IF NOT EXISTS actor_role text
  CHECK (actor_role IS NULL OR actor_role IN ('reader','writer','owner'));
-- Allowing an agent asks for no token name (decision_01M4EQPJ6AKETJ1508W254DXVB):
-- its connection goes by the client's name. API keys still carry their label
-- on the access and refresh tokens.
ALTER TABLE oauth_authorization_codes DROP COLUMN IF EXISTS token_name;
ALTER TABLE oauth_device_authorizations DROP COLUMN IF EXISTS token_name;

-- Untie chat_attachments from a single conversation. The composer uploads
-- bytes before the turn knows which thread it runs on, so keying the row to a
-- conversation dropped the file whenever the upload thread and the message
-- thread differed (a collection page's first message). Attachments are owned by the
-- principal now; reads filter on user_id. Drop the conversation index first
-- (it depends on the column), then the column itself.
DROP INDEX IF EXISTS idx_chat_attachments_conversation;
ALTER TABLE chat_attachments DROP COLUMN IF EXISTS conversation_id;

-- Slack mirror history backfill (added after the mirror tables first shipped).
ALTER TABLE group_chat_mirrors ADD COLUMN IF NOT EXISTS channels_synced_at timestamptz;
ALTER TABLE group_chat_mirrors ADD COLUMN IF NOT EXISTS history_next_at timestamptz;
ALTER TABLE group_chat_mirrors ADD COLUMN IF NOT EXISTS replies_next_at timestamptz;
ALTER TABLE group_chat_channels ADD COLUMN IF NOT EXISTS history_oldest_ts text;
ALTER TABLE group_chat_channels ADD COLUMN IF NOT EXISTS decision_offers boolean NOT NULL DEFAULT false;
-- Quieting Señor Doco from Slack is gone: Manage under what he posts unasked
-- opens the team's Slack settings on doco.to (Alexander, 2026-11-03: "No
-- management options in Slack other than the button to go to Doco."). A
-- channel someone quieted stays quiet through the switches there: the Times
-- off where it was his channel, and no watching for decisions in it. What was
-- quiet_at lives on only as a thread's closed_at.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'group_chat_conversations'
                AND column_name = 'quiet_at') THEN
    UPDATE group_chat_installations i SET digest = 'off', updated_at = now()
      FROM group_chat_conversations q
     WHERE q.provider = i.provider AND q.workspace_id = i.workspace_id
       AND q.conversation_id = i.default_channel_id AND q.quiet_at IS NOT NULL;
    UPDATE group_chat_channels gc SET decision_offers = false
      FROM group_chat_mirrors m
      JOIN group_chat_installations i ON i.id = m.installation_id
      JOIN group_chat_conversations q
        ON q.provider = i.provider AND q.workspace_id = i.workspace_id AND q.quiet_at IS NOT NULL
     WHERE m.collection_id = gc.collection_id AND q.conversation_id = gc.channel_id;
    ALTER TABLE group_chat_conversations RENAME COLUMN quiet_at TO closed_at;
    UPDATE group_chat_conversations SET closed_at = NULL
     WHERE closed_at IS NOT NULL AND position('/' IN conversation_id) = 0;
  END IF;
END $$;
ALTER TABLE group_chat_messages ADD COLUMN IF NOT EXISTS replies_cursor text;
-- Thread roots whose earlier replies the backfill still has to fetch.
CREATE INDEX IF NOT EXISTS group_chat_messages_replies_pending_idx
  ON group_chat_messages (collection_id) WHERE reply_count > 0 AND replies_synced_at IS NULL;

-- The Slack mirror's perspective (a Slack-mirror collection's channel reader). Its
-- kind joins the perspectives CHECK here, before its built-in row, because on
-- an existing database the inline CHECK above is a no-op and the old
-- constraint would reject the row and abort the schema apply. Codebase and
-- Notion collections open in a reader of their own (the web app's reader.ts), so
-- the Code and Notion perspectives they had are deleted first, taking every
-- collection's attachment to them along (ON DELETE CASCADE).
DELETE FROM perspectives WHERE id IN ('perspective_code', 'perspective_notion');
ALTER TABLE perspectives DROP CONSTRAINT IF EXISTS perspectives_kind_check;
ALTER TABLE perspectives ADD CONSTRAINT perspectives_kind_check
  CHECK (kind IN ('graph','list','process','org-tree','sla','glossary','pull-requests','slack','documents'));
INSERT INTO perspectives (id, slug, kind, name, description, icon, owner_handle, is_builtin, config) VALUES
  ('perspective_slack','slack','slack','Slack','A mirrored Slack workspace''s public channels: messages, threads, and search.','💬',NULL,true,'{}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- The Documents perspective: a Documents collection's documents. Its kind
-- joined the perspectives CHECK above, before this row, for the same reason.
INSERT INTO perspectives (id, slug, kind, name, description, icon, owner_handle, is_builtin, config) VALUES
  ('perspective_documents','documents','documents','Documents','The documents of a Documents collection, the one edited last first.','📄',NULL,true,'{}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- Actor access tokens act as their user, capped at actor_role, resolved live —
-- so the access token (not just the refresh token) carries the actor marker.
ALTER TABLE oauth_access_tokens
  ADD COLUMN IF NOT EXISTS grant_type text NOT NULL DEFAULT 'regular'
  CHECK (grant_type IN ('regular', 'actor'));
ALTER TABLE oauth_access_tokens
  ADD COLUMN IF NOT EXISTS actor_role text
  CHECK (actor_role IS NULL OR actor_role IN ('reader','writer','owner'));

-- When the token last authenticated a request: /tokens' "Last used". Filled
-- from created_at, the best known, on the boot that adds it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'oauth_access_tokens'
       AND column_name = 'last_used_at'
  ) THEN
    ALTER TABLE oauth_access_tokens ADD COLUMN last_used_at timestamptz;
    UPDATE oauth_access_tokens SET last_used_at = created_at;
  END IF;
END $$;

-- ──────────────────────────────────────────────────────────────────────────
-- account_grants retirement. The live person-to-person "all my workspaces,
-- including ones I create later" delegation is gone: that breadth now lives
-- ONLY on tokens (the actor / mint-time snapshot paths). A grant to another
-- PERSON must name concrete, existing targets, so the table is dropped. To
-- avoid silently revoking access, first convert every surviving grant into the
-- memberships it currently confers — a snapshot of the grantor's owned
-- workspaces and personally-owned collections (the access cascade is now pure
-- workspace_users + collection_users). Guarded + self-removing: runs once on the
-- first boot that still has the table, then never again.
DO $$
BEGIN
  IF to_regclass('public.account_grants') IS NOT NULL THEN
    INSERT INTO workspace_users (workspace_id, user_id, role, write_types)
    SELECT wu.workspace_id, ag.grantee_user_id, ag.role, ag.write_types
      FROM account_grants ag
      JOIN workspace_users wu
        ON wu.user_id = ag.grantor_user_id AND wu.role = 'owner'
    ON CONFLICT (workspace_id, user_id) DO NOTHING;

    INSERT INTO collection_users (collection_id, user_id, role, write_types)
    SELECT d.id, ag.grantee_user_id, ag.role, ag.write_types
      FROM account_grants ag
      JOIN collections d ON d.owner_id = ag.grantor_user_id
    ON CONFLICT (collection_id, user_id) DO NOTHING;

    DROP TABLE account_grants;
  END IF;
END $$;

-- Embedding rows follow their entity: deleting a node, a policy, a Notion
-- page, a Slack message or a Google Drive file, directly or through a
-- cascade, drops its chunks, so no application path has to remember to.
CREATE OR REPLACE FUNCTION embeddings_drop_for_row() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'notion_pages' THEN
    DELETE FROM embeddings
     WHERE collection_id = OLD.collection_id AND source = 'notion' AND entity_id = OLD.page_id;
  ELSIF TG_TABLE_NAME = 'group_chat_messages' THEN
    DELETE FROM embeddings
     WHERE collection_id = OLD.collection_id AND source = 'slack'
       AND entity_id = OLD.channel_id || ':' || OLD.ts;
  ELSIF TG_TABLE_NAME = 'google_drive_files' THEN
    DELETE FROM embeddings
     WHERE collection_id = OLD.collection_id AND source = 'google_drive'
       AND entity_id = OLD.file_id;
  ELSE
    DELETE FROM embeddings
     WHERE collection_id = OLD.collection_id AND source = 'node' AND entity_id = OLD.id;
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS nodes_embeddings_drop ON nodes;
CREATE TRIGGER nodes_embeddings_drop
  AFTER DELETE ON nodes FOR EACH ROW EXECUTE FUNCTION embeddings_drop_for_row();
DROP TRIGGER IF EXISTS policies_embeddings_drop ON policies;
CREATE TRIGGER policies_embeddings_drop
  AFTER DELETE ON policies FOR EACH ROW EXECUTE FUNCTION embeddings_drop_for_row();
DROP TRIGGER IF EXISTS notion_pages_embeddings_drop ON notion_pages;
CREATE TRIGGER notion_pages_embeddings_drop
  AFTER DELETE ON notion_pages FOR EACH ROW EXECUTE FUNCTION embeddings_drop_for_row();
DROP TRIGGER IF EXISTS group_chat_messages_embeddings_drop ON group_chat_messages;
CREATE TRIGGER group_chat_messages_embeddings_drop
  AFTER DELETE ON group_chat_messages FOR EACH ROW EXECUTE FUNCTION embeddings_drop_for_row();
DROP TRIGGER IF EXISTS google_drive_files_embeddings_drop ON google_drive_files;
CREATE TRIGGER google_drive_files_embeddings_drop
  AFTER DELETE ON google_drive_files FOR EACH ROW EXECUTE FUNCTION embeddings_drop_for_row();

-- ──────────────────────────────────────────────────────────────────────────
-- Silence alerts: an integration collection that stopped receiving data, or an agent
-- that stopped reading and writing in a workspace for longer than its own
-- history makes expected, or that keeps reading but stopped writing
-- (silence-alerts.server.ts decides, every hour). A row is one episode: it
-- opens when the silence turns unexpected, its emails, and Señor Doco's
-- Slack messages with them, go out along the schedule (email_step), and it is
-- deleted when data or calls resume. An owner of the workspace can nudge an
-- agent's person (nudged_at) or disregard its alert, just this time
-- (disregarded_at) or always (disregarded_agents).
CREATE TABLE IF NOT EXISTS silence_alerts (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- What went quiet: an integration collection, or an agent (a person and the agent
  -- they read and write through, named as agentName names it).
  collection_id       text REFERENCES collections(id) ON DELETE CASCADE,
  user_id       text REFERENCES users(id) ON DELETE CASCADE,
  agent         text,
  -- The collections it concerns: the integration collection, or the ones the agent used.
  collection_ids      text[] NOT NULL,
  -- The last item or call before the silence; for an agent that still reads,
  -- its last write; for an agent never used, or that never wrote, when it
  -- was connected.
  quiet_since   timestamptz NOT NULL,
  -- An agent that still reads, though it has written nothing since quiet_since.
  reading       boolean NOT NULL DEFAULT false,
  -- How many the same hours of past weeks (up to four) brought, on average;
  -- 0 for an agent with less than a week of history, or that still reads.
  usual         int NOT NULL,
  opened_at     timestamptz NOT NULL DEFAULT now(),
  -- The last step of the email schedule that went out: 0 none yet, 1 after a
  -- week of silence, 2 two weeks, 3 a month.
  email_step    int NOT NULL DEFAULT 0 CHECK (email_step BETWEEN 0 AND 3),
  -- When an owner of the workspace emailed the agent's person about it.
  nudged_at     timestamptz,
  -- When an owner of the workspace disregarded it: the row stays, so the
  -- check doesn't open it again, but no page shows it and nothing is sent
  -- until it closes.
  disregarded_at timestamptz,
  CHECK ((collection_id IS NOT NULL) <> (user_id IS NOT NULL AND agent IS NOT NULL))
);
ALTER TABLE silence_alerts
  ADD COLUMN IF NOT EXISTS nudged_at timestamptz,
  ADD COLUMN IF NOT EXISTS disregarded_at timestamptz;
-- The agents an owner of a workspace disregarded always: no alert opens about
-- that person's agent in that workspace again.
CREATE TABLE IF NOT EXISTS disregarded_agents (
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent         text NOT NULL,
  disregarded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, agent)
);
CREATE UNIQUE INDEX IF NOT EXISTS silence_alerts_collection_idx
  ON silence_alerts (collection_id) WHERE collection_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS silence_alerts_agent_idx
  ON silence_alerts (workspace_id, user_id, agent) WHERE agent IS NOT NULL;
CREATE INDEX IF NOT EXISTS silence_alerts_collections_idx ON silence_alerts USING gin (collection_ids);

-- Each person, by GitHub login, whose pull requests a workspace can't see:
-- they aren't a member, or their agent shipped without Doco (web:
-- lib/unseen-work-alerts.server.ts). The pull requests opened up to
-- told_through were sent; an owner's Disregard hides those opened up to
-- disregarded_through (just this time), or every one (always). The weekly
-- marker per author it replaces is gone (Alexander, 2026-11-02: "we should
-- not wait one week any longer").
DROP TABLE IF EXISTS unseen_work_alerts;
CREATE TABLE IF NOT EXISTS unseen_work_authors (
  workspace_id        text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  login               text NOT NULL CHECK (login = lower(login)),
  told_through        timestamptz,
  disregarded_through timestamptz,
  disregarded_always  boolean NOT NULL DEFAULT false,
  PRIMARY KEY (workspace_id, login)
);
-- The pull requests imported before they carried labels (the agent that made
-- each and how Doco saw the work, web: lib/pull-request-provenance.ts) are
-- imported again once, in every workspace (decision_01M655E2KR8SD7C11QX823WKYV;
-- Alexander, 2026-10-30, "Spot agents committing without Doco"): each
-- connected collection that brings pull requests from GitHub, last imported
-- before labels shipped, is queued for the background import "Re-import all"
-- starts, a running marker with no cursor, which the sweep picks up and the
-- worker rebuilds from the collection's connections. Labels go on past the
-- judge (labelPullRequest), so it costs no model call. Its import stamps the
-- marker after then, so a later boot queues nothing. Moved on when a brief or
-- record of another workspace stopped counting as going through Doco, when
-- each pull request came to carry who opened it, for the alerts about someone
-- who isn't a member, when only its author's records came to count as
-- logging it (Alexander, 2026-11-02, "Find why no alert for Oki skipping
-- Doco"), and when Doco came to look in every workspace that tracks the
-- repository, as worder tracks The Voice Store's (Alexander, 2026-11-02), so
-- the pull requests labeled before relabel too.
-- The build applies this while the deploy before it still serves, and the
-- sweep (web: routes/api.github.backfill-sweep.tsx) takes up an import whose
-- cursor sat still five minutes: the marker's cursor stands five minutes
-- ahead, so the import starts ten minutes on, under this deploy's code. The
-- first move's ran under the old code at once, and labeled as before.
UPDATE collections
   SET data = jsonb_set(data, '{github_integration,backfill}',
                        jsonb_build_object('status', 'running', 'cursor_at', now() + interval '5 minutes'),
                        true)
 WHERE deleted_at IS NULL
   AND coalesce(data->>'template_handle', '') NOT IN ('github-issues', 'codebase')
   AND jsonb_path_exists(
         data,
         '$.github_integration.connections[*] ? (@.repo.type() == "string" && @.installation_id.type() == "number")')
   AND coalesce(data->'github_integration'->'backfill'->>'status', '') <> 'running'
   AND coalesce((data->'github_integration'->'backfill'->>'cursor_at')::timestamptz, 'epoch')
       < '2026-11-02T22:45:00Z';
-- The schedule opened with an email after a workday of silence until it
-- started at a week: each alert's step moves down one, the workday's to none,
-- once, as the step's range check arrives.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'silence_alerts'::regclass
       AND conname = 'silence_alerts_email_step_check'
  ) THEN
    UPDATE silence_alerts SET email_step = greatest(email_step - 1, 0);
    ALTER TABLE silence_alerts ADD CONSTRAINT silence_alerts_email_step_check
      CHECK (email_step BETWEEN 0 AND 3);
  END IF;
END $$;

-- ──────────────────────────────────────────────────────────────────────────
-- Activity. A collection's activity is a change to its content (an audit event;
-- policies are settings, not activity) or an item an integration brought.
-- imported_items is the one definition of the latter, read by the activity
-- logs, item counts, silence alerts and integration status (lib/
-- activity-log.server.ts and its readers): from GitHub the files of a codebase
-- and the pull requests and issues it keeps (a pull request's Reference, an
-- issue's Eval), from Slack the messages of the channels it copies, from
-- Notion the pages fetched so far, from Google Drive the files copied so far
-- (folders aside). `at` is when an item happened in the source where the
-- source says (a message posted, a page or file last changed; null when
-- Notion gave no time), else when Doco last wrote it (a code file, a pull
-- request or issue). Each branch has an index on (collection_id, at), with its WHERE
-- as a partial one's predicate where it filters.
CREATE OR REPLACE VIEW imported_items AS
  SELECT i.collection_id, 'github'::text AS integration, i.synced_at AS at FROM code_files i
  UNION ALL
  SELECT i.collection_id, 'github', i.updated_at FROM nodes i
   WHERE i.node_type IN ('reference', 'eval')
     AND i.locator ~ '^https://github\.com/[^/]+/[^/]+/(pull|issues)/[0-9]+$'
  UNION ALL
  SELECT i.collection_id, 'slack', i.posted_at FROM group_chat_messages i
   WHERE NOT EXISTS (SELECT 1 FROM group_chat_channels ch
                      WHERE ch.collection_id = i.collection_id AND ch.channel_id = i.channel_id
                        AND ch.excluded)
  UNION ALL
  SELECT i.collection_id, 'notion', i.last_edited_time FROM notion_pages i
   WHERE i.synced_at IS NOT NULL
  UNION ALL
  SELECT i.collection_id, 'google-drive', i.modified_time FROM google_drive_files i
   WHERE i.synced_at IS NOT NULL AND i.kind <> 'folder';

-- When each collection last saw activity, kept on its row so pages read it with the
-- collections they load instead of probing every source on every view
-- (decision_01M4GZ5ZJ30TM35CV77ZYREAA9). After each statement that writes a
-- source, every collection it touched catches up to its newest activity after the
-- stored time: a ranged read of each source's (collection_id, at) index, so old
-- history (an import of last year's messages) reads nothing and moves
-- nothing. It only moves forward. Custom plans, because the range decides
-- whether an index or a scan is right.
CREATE OR REPLACE FUNCTION collection_catch_up_activity(collection text) RETURNS void AS $$
DECLARE
  since timestamptz := coalesce(
    (SELECT latest_activity_at FROM collections WHERE id = collection), '-infinity');
  newest timestamptz;
BEGIN
  newest := GREATEST(
    (SELECT max(a.at) FROM audit_events a
      WHERE a.collection_id = collection AND a.at > since AND a.entity_type <> 'policy'),
    (SELECT max(i.at) FROM imported_items i WHERE i.collection_id = collection AND i.at > since));
  IF newest IS NOT NULL THEN
    UPDATE collections SET latest_activity_at = GREATEST(latest_activity_at, newest) WHERE id = collection;
  END IF;
END;
$$ LANGUAGE plpgsql SET plan_cache_mode = force_custom_plan;

-- The trigger on each source, given the source's time column: only the collections
-- the statement wrote something newer than their stored time to catch up, so
-- an import of old history costs one cheap look at the rows it wrote.
CREATE OR REPLACE FUNCTION catch_up_collections_activity() RETURNS trigger AS $$
BEGIN
  EXECUTE format(
    'SELECT collection_catch_up_activity(w.collection_id)
       FROM (SELECT collection_id, max(%I) AS at FROM changed_rows GROUP BY collection_id) w
       JOIN collections d ON d.id = w.collection_id
      WHERE w.at > coalesce(d.latest_activity_at, ''-infinity'')',
    TG_ARGV[0]);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Filled once, from each collection's whole history, on the boot that adds it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'collections'
       AND column_name = 'latest_activity_at'
  ) THEN
    ALTER TABLE collections ADD COLUMN latest_activity_at timestamptz;
    PERFORM collection_catch_up_activity(id) FROM collections;
  END IF;
END $$;

-- Every write to a source catches its collections up. Slack messages and audit
-- events are only ever inserted with their time; the rest change it when
-- rewritten (a file resynced, a pull request updated, a Notion page or a
-- Drive file fetched).
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    ('audit_events', 'INSERT', 'at'),
    ('group_chat_messages', 'INSERT', 'posted_at'),
    ('code_files', 'INSERT', 'synced_at'), ('code_files', 'UPDATE', 'synced_at'),
    ('nodes', 'INSERT', 'updated_at'), ('nodes', 'UPDATE', 'updated_at'),
    ('notion_pages', 'INSERT', 'last_edited_time'), ('notion_pages', 'UPDATE', 'last_edited_time'),
    ('google_drive_files', 'INSERT', 'modified_time'), ('google_drive_files', 'UPDATE', 'modified_time')
  ) AS v(tbl, ev, at) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t.tbl || '_activity_' || lower(t.ev), t.tbl);
    EXECUTE format(
      'CREATE TRIGGER %I AFTER %s ON %I REFERENCING NEW TABLE AS changed_rows '
      'FOR EACH STATEMENT EXECUTE FUNCTION catch_up_collections_activity(%L)',
      t.tbl || '_activity_' || lower(t.ev), t.ev, t.tbl, t.at);
  END LOOP;
END $$;

-- Email sign-in replaced GitHub sign-in (decision_01M5EA9HVPXG0SF7FVZWCGXSQ1).
-- A person's name moves from their GitHub login to users.username, filled
-- once, on the boot that adds the column: a second login that differs from an
-- earlier one only by case is numbered, since names are unique regardless of
-- case (decision_01M5EAAX2VT2MMRG0ZGKDJGMJZ).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'users'
       AND column_name = 'username'
  ) THEN
    ALTER TABLE users ADD COLUMN username text;
    UPDATE users u
       SET username = CASE WHEN n.rank = 1 THEN u.github_login
                           ELSE u.github_login || '-' || n.rank END
      FROM (SELECT id, row_number() OVER (PARTITION BY lower(github_login)
                                          ORDER BY created_at, id) AS rank
              FROM users WHERE github_login IS NOT NULL) n
     WHERE n.id = u.id;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS users_username_key ON users (lower(username));
ALTER TABLE users ADD COLUMN IF NOT EXISTS public_profile boolean NOT NULL DEFAULT false;
-- An address signs in one person: made unique once, a blank one counting as
-- none and a later account sharing an address losing it to the first.
DO $$
BEGIN
  IF to_regclass('users_email_key') IS NULL THEN
    UPDATE users SET email = NULL WHERE btrim(email) = '';
    UPDATE users u SET email = NULL
      FROM (SELECT id, row_number() OVER (PARTITION BY lower(email)
                                          ORDER BY created_at, id) AS rank
              FROM users WHERE email IS NOT NULL) n
     WHERE n.id = u.id AND n.rank > 1;
    CREATE UNIQUE INDEX users_email_key ON users (lower(email));
  END IF;
END $$;
-- Only GitHub sign-in read github_id; nothing ever wrote avatar_url; and the
-- kind column production still carried was written and never read.
ALTER TABLE users
  DROP COLUMN IF EXISTS github_id,
  DROP COLUMN IF EXISTS avatar_url,
  DROP COLUMN IF EXISTS kind;
-- password_email_sent_at claimed each GitHub-era person for the one email
-- asking them to choose a password (decision_01M5EA9JYTP68Y3EDX11805BXV),
-- which went out on 2026-10-21; it went with the job.
ALTER TABLE users DROP COLUMN IF EXISTS password_email_sent_at;
-- A database from before sessions carried a stamp gives each person a new
-- one, which signs them out (decision_01M644H4Y6SAKGVX7HK0TNG65R). Passwords
-- came back next to passkeys the day after they were dropped
-- (decision_01M644G5305NGN9JB7XJPRGN9H), so everyone chooses a new one.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS stamp text NOT NULL DEFAULT gen_random_uuid()::text,
  ADD COLUMN IF NOT EXISTS password_hash text;
-- A person's name, filled once, on the boot that adds the column, from the
-- real name of the Slack account they linked where a Slack copy of its team
-- lists them; everyone else writes theirs on their profile.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'users'
       AND column_name = 'name'
  ) THEN
    ALTER TABLE users ADD COLUMN name text;
    UPDATE users u
       SET name = s.real_name
      FROM (SELECT DISTINCT ON (l.user_id) l.user_id, btrim(m.real_name) AS real_name
              FROM group_chat_user_links l
              JOIN group_chat_installations i
                ON i.provider = l.provider AND i.workspace_id = l.workspace_id
              JOIN group_chat_mirrors gm ON gm.installation_id = i.id
              JOIN group_chat_members m
                ON m.collection_id = gm.collection_id AND m.chat_user_id = l.chat_user_id
             WHERE btrim(m.real_name) <> '' AND NOT m.is_bot
             ORDER BY l.user_id, l.updated_at DESC) s
     WHERE s.user_id = u.id;
  END IF;
END $$;
-- The host superadmin, whom the admin pages answer, was known by the username
-- torrenegra until people could change their usernames, which would let
-- whoever took that name in. On the boot that adds the column, the person
-- named torrenegra is marked; nothing marks anyone after that
-- (decision_01M64TCQ49GMRY08FWY05HC5GR).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'users'
       AND column_name = 'superadmin'
  ) THEN
    ALTER TABLE users ADD COLUMN superadmin boolean NOT NULL DEFAULT false;
    UPDATE users SET superadmin = true WHERE username = 'torrenegra';
  END IF;
END $$;

-- A chat's Log is one short line: who asked for what and what came of it
-- (Alexander, 2026-10-21: "Agents should be taught to make one-line comments,
-- rather than a long log of everything they do"). An Agents chats collection's
-- goal and active policies that still read as its template first wrote them
-- take the template's new wording; whatever an owner rewrote keeps its own.
-- Only the old wording matches, so a reboot changes nothing. The block goes
-- once production has applied it.
UPDATE collections
   SET goal = 'Record every chat an agent has with a user in one short line — who asked for what and what came of it — one Log per chat, pointing to the decisions and work it produced.',
       updated_at = now()
 WHERE data->>'template_handle' = 'agents-chats'
   AND goal = 'Record every chat an agent has with a user — who took part, what was asked, what was worked on, what came of it, and what was left open — one Log per chat, pointing to the decisions and work it produced.';
UPDATE policies p
   SET data = jsonb_set(p.data, '{predicate,agent_instruction}', to_jsonb(w.new)),
       updated_at = now()
  FROM collections d,
       (VALUES
         ('A chat Log names who took part (the user by name, the agent by its credential label), what the user asked for, what was worked on, what came of it, and what was left open. Pass when all five are clear from the Log; fail when any is missing or vague.',
          'A chat Log is one short line naming who asked for what (the user by name, the agent by its credential label) and what came of it. Pass when one line says both; fail when it runs past one line, recounts the steps taken, or leaves either out.'),
         ('Capture the Log before the chat ends, with `verb` "chatted", `happened_at` when the chat began, and `prose` that summarizes the chat in the third person. Summarize rather than transcribe; quote the user only where the exact words matter, such as a requirement, a correction or an approval.',
          'Capture the Log with `verb` "chatted", `happened_at` when the chat began, and `prose` of one short line in the third person, such as "Ana asked Claude Code to fix the sign-in redirect; it opened PR #42." Leave out the steps along the way: what the chat produced carries the detail. Supersede the Log only when what came of the chat changes.')
       ) AS w(old, new)
 WHERE d.id = p.collection_id
   AND d.data->>'template_handle' = 'agents-chats'
   AND p.lifecycle = 'active'
   AND p.data->'predicate'->>'agent_instruction' = w.old;

-- Every workspace's constitution says what to record and where, since Doco's
-- agent instructions no longer name a collection (Alexander, 2026-10-21: "the
-- instructions shouldn't make reference to it. The Constitutions should.";
-- "Update all constitutions"). Each constitution loses the paragraphs a stock
-- default gave it, in either wording, and ends with the new default, so a
-- stock one becomes the default and one an owner added to keeps the owner's
-- paragraphs above it. One that already carries the new text is left alone,
-- so a reboot changes nothing. The block goes once production has applied it.
UPDATE workspaces w
   SET constitution = CASE WHEN s.kept = '' THEN s.fresh ELSE s.kept || E'\n\n' || s.fresh END,
       updated_at = now()
  FROM (SELECT id,
               btrim(regexp_replace(
                 regexp_replace(constitution,
                   '(This is a spec-driven development project\.|Follow the policies of every (Doco|collection) in this workspace\. They are binding|Document anything a future collaborator,|Three duties are not optional\.).*',
                   '', 'gn'),
                 '\n{3,}', E'\n\n', 'g'), E' \n') AS kept,
               $constitution$Follow the policies of every collection in this workspace. They bind: when two seem to conflict, say so rather than picking one.

Document what a future collaborator, person or agent, would need for context: the reasoning behind decisions, the constraints that ruled out alternatives, and the rules that emerged. If it would be hard to reconstruct later, write it down now.

Record each chat as a Log in Agents chats, in one short line: who asked for what and what came of it.

Record each decision as it is made, as a Decision with the question, the choice, and the alternatives that lost and why. Put it in:

- Product decisions when it sets what users or the business get (what to build, fix, charge or pay), even when it ships as code;
- Design decisions when it sets how something looks or behaves for the people using it;
- Architectural decisions when it sets how the system does it: structure, technology, data.

A choice with both sides is two Decisions, each citing the other's id.

When a decision changes a business process, change that process in Processes too, citing the decision's id.$constitution$ AS fresh
          FROM workspaces) s
 WHERE w.id = s.id
   AND strpos(w.constitution, 'A choice with both sides is two Decisions') = 0;

-- A Log or an Action was saved retired, meaning it was done, until
-- 2026-10-26; everywhere else retired means replaced or withdrawn, so feeds
-- struck every chat Log through and the graph, search and briefs hid them.
-- They are saved active now, and those saved before that nothing replaced
-- and nobody retired become active too. Only nodes saved before the change
-- qualify, so one saved retired on purpose since stays retired. updated_at
-- stays as it was: nothing about them changed but the word for their state,
-- and a fresh one would put every old Log in this week's briefs.
UPDATE nodes n
   SET lifecycle = 'active'
 WHERE n.node_type IN ('log', 'action')
   AND n.lifecycle = 'retired'
   AND n.created_at < '2026-10-27T00:00:00Z'
   AND NOT EXISTS (
         SELECT 1 FROM edges e
          WHERE e.to_id = n.id AND e.edge_type = 'replaces')
   AND NOT EXISTS (
         SELECT 1 FROM audit_events a
          WHERE a.entity_id = n.id AND a.op = 'lifecycle.transition'
            AND a.after_json->>'lifecycle' = 'retired');

-- How many tokens each collection holds, four characters a token as the brief
-- counts them, by where they come from: its live records' prose and what its
-- copies of Slack (but the channels left out of the copy), Notion, Google
-- Drive and code hold. Every brief and search says how many it searched, and
-- the query log keeps it (metadata.searched_tokens); the activity rollup's
-- hourly cron recounts it (lib/collection-tokens.server.ts).
CREATE TABLE IF NOT EXISTS collection_tokens (
  collection_id  text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  source         text NOT NULL
                   CHECK (source IN ('records', 'slack', 'notion', 'google_drive', 'code')),
  tokens         bigint NOT NULL,
  PRIMARY KEY (collection_id, source)
);
CREATE OR REPLACE FUNCTION refresh_collection_tokens() RETURNS void AS $$
  DELETE FROM collection_tokens;
  INSERT INTO collection_tokens (collection_id, source, tokens)
  SELECT collection_id, source, sum(chars) / 4 FROM (
    SELECT collection_id, 'records' AS source, length(prose) AS chars
      FROM nodes WHERE lifecycle <> 'retired'
    UNION ALL
    SELECT m.collection_id, 'slack', length(m.text)
      FROM group_chat_messages m
      JOIN group_chat_channels ch
        ON ch.collection_id = m.collection_id AND ch.channel_id = m.channel_id
     WHERE NOT ch.excluded
    UNION ALL
    SELECT collection_id, 'notion', length(plain_text) FROM notion_pages
    UNION ALL
    SELECT collection_id, 'google_drive', length(plain_text) FROM google_drive_files
    UNION ALL
    SELECT collection_id, 'code', length(content) FROM code_files
  ) r
  GROUP BY collection_id, source;
$$ LANGUAGE sql;

-- The tokens each day's queries searched, counted into activity_days with the
-- boot that adds the column, which first gives every brief logged before
-- briefs said what they searched its searched_tokens: what the workspace's
-- collections its asker could read held when the brief's UTC day began (a
-- hook token reads as its maker, a member of its workspace), each item dated
-- when it reached Doco (a copied one no earlier than its copy), and without
-- code, which the brief doesn't search. Other past queries can't be told
-- apart from reads that searched nothing, so they stay without. Then the
-- rollup starts over, so its next run counts every day again, tokens and all.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'activity_days'
       AND column_name = 'tokens'
  ) THEN
    ALTER TABLE activity_days ADD COLUMN tokens bigint NOT NULL DEFAULT 0;
    PERFORM refresh_collection_tokens();
    WITH added AS (
      SELECT collection_id, (at AT TIME ZONE 'UTC')::date AS day, sum(chars) AS chars FROM (
        SELECT collection_id, created_at AS at, length(prose) AS chars
          FROM nodes WHERE lifecycle <> 'retired'
        UNION ALL
        SELECT m.collection_id, greatest(m.posted_at, g.consented_at), length(m.text)
          FROM group_chat_messages m
          JOIN group_chat_mirrors g ON g.collection_id = m.collection_id
          JOIN group_chat_channels ch
            ON ch.collection_id = m.collection_id AND ch.channel_id = m.channel_id
         WHERE NOT ch.excluded
        UNION ALL
        SELECT p.collection_id, greatest(p.created_time, n.consented_at), length(p.plain_text)
          FROM notion_pages p JOIN notion_mirrors n ON n.collection_id = p.collection_id
        UNION ALL
        SELECT f.collection_id, greatest(f.modified_time, g.consented_at), length(f.plain_text)
          FROM google_drive_files f JOIN google_drive_mirrors g ON g.collection_id = f.collection_id
      ) r
      GROUP BY 1, 2
    ),
    briefs AS (
      SELECT e.id, e.workspace_id, e.actor, e.at, (e.at AT TIME ZONE 'UTC')::date AS day,
             (e.actor IS NULL AND e.metadata->>'auth' = 'bearer')
               OR EXISTS (SELECT 1 FROM workspace_users wu
                           WHERE wu.workspace_id = e.workspace_id AND wu.user_id = e.actor)
               AS member
        FROM query_events e
       WHERE e.metadata ? 'brief_id'
    ),
    size AS (
      SELECT a.collection_id, d.day, sum(a.chars) AS chars
        FROM (SELECT DISTINCT day FROM briefs) d JOIN added a ON a.day < d.day
       GROUP BY 1, 2
    ),
    searched AS (
      SELECT b.id, div(coalesce(sum(s.chars), 0), 4)::bigint AS tokens
        FROM briefs b
        JOIN collections d
          ON d.workspace_id = b.workspace_id AND d.created_at <= b.at
         AND (d.deleted_at IS NULL OR d.deleted_at > b.at)
         AND (b.member OR d.visibility = 'public'
              OR EXISTS (SELECT 1 FROM collection_users cu
                          WHERE cu.collection_id = d.id AND cu.user_id = b.actor))
        LEFT JOIN size s ON s.collection_id = d.id AND s.day = b.day
       GROUP BY b.id
    )
    UPDATE query_events e
       SET metadata = e.metadata || jsonb_build_object('searched_tokens', s.tokens)
      FROM searched s
     WHERE s.id = e.id;
    DELETE FROM activity_days;
    DELETE FROM activity_rollup;
  END IF;
END $$;

-- Who asked for an invite at /request-invite, one row per address, and how
-- the admins answered from /admin/invite-requests (lib/invite-requests.server.ts):
-- `code` is the invite code of their own that Send invite emailed them, which
-- /sign-up takes once (`code_used_at`); whether they then signed up is read
-- from users by the address (decision_01M6HZ6BS1JA3DPP4TBAAP3AX7).
CREATE TABLE IF NOT EXISTS invite_requests (
  email         text PRIMARY KEY,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  invited_at    timestamptz,
  invited_by    text REFERENCES users(id) ON DELETE SET NULL,
  code          text UNIQUE,
  code_used_at  timestamptz
);

-- Expiring ownership for the long-running background sweeps. A Vercel hard
-- timeout cannot run a finally block, so session advisory locks can strand a
-- job forever; these rows make every abandoned claim recover by itself.
CREATE TABLE IF NOT EXISTS background_job_leases (
  name          text PRIMARY KEY,
  owner         text NOT NULL,
  leased_until  timestamptz NOT NULL
);

-- The fingerprint of the schema.sql last applied (packages/db/src/client.ts):
-- a cold start applies this file only when it differs, so its every change
-- still reaches the database on the first boot after it deploys and its
-- migrations stay idempotent (decision_01M4CH63Z7SP3XZFNE8TY811BN).
CREATE TABLE IF NOT EXISTS schema_applied (
  one         boolean PRIMARY KEY DEFAULT true CHECK (one),
  hash        text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
