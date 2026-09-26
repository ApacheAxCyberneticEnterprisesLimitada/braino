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

-- Host config (singleton row at id='host').
CREATE TABLE IF NOT EXISTS hosts (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  visibility  text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

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

-- Every constitution carries the three baseline agent duties (load context,
-- document every decision, record every conversation). New workspaces get
-- them from DEFAULT_WORKSPACE_CONSTITUTION (packages/shared/src/constitution.ts);
-- this appends the same paragraph to any existing constitution that lacks it,
-- so a workspace still on the old default becomes byte-identical to the new
-- one and a customized charter keeps its text. Only constitutions without the
-- paragraph match, so a reboot never rewrites one that already has it. The
-- paragraph is kept byte-for-byte in sync with constitution.ts by
-- packages/db/src/__tests__/constitution-duties-backfill.test.ts.
UPDATE workspaces
   SET constitution = CASE
         WHEN constitution = '' THEN $duties$Three duties are not optional. Load context at the start of every session by querying this workspace's Docos before the first substantive reply. Document every decision as it is made, with the alternatives that lost and why. Record every conversation before it ends: what was worked on, what was decided, and what was left open.$duties$
         ELSE constitution || E'\n\n' || $duties$Three duties are not optional. Load context at the start of every session by querying this workspace's Docos before the first substantive reply. Document every decision as it is made, with the alternatives that lost and why. Record every conversation before it ends: what was worked on, what was decided, and what was left open.$duties$
       END,
       updated_at = now()
 WHERE position($duties$Three duties are not optional. Load context at the start of every session by querying this workspace's Docos before the first substantive reply. Document every decision as it is made, with the alternatives that lost and why. Record every conversation before it ends: what was worked on, what was decided, and what was left open.$duties$ IN constitution) = 0;

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
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Soft-delete tombstone. NULL = live; a timestamp = deleted, awaiting the
  -- 30-day purge sweep (admin.purge-deleted-docos cron) that hard-deletes it
  -- via ON DELETE CASCADE. Every read path filters `deleted_at IS NULL`, so a
  -- tombstoned Doco is invisible everywhere — unreachable by URL, gone from
  -- every listing — while its rows are retained for the grace window. On
  -- delete the handle is rewritten to `<handle>-deleted-<epoch-millis>`, which
  -- frees the original name for immediate reuse while keeping the tombstone's
  -- own handle unique (UNIQUE above still spans tombstoned rows).
  deleted_at      timestamptz
);

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
  lifecycle   text NOT NULL DEFAULT 'active'
                CONSTRAINT policies_lifecycle_check CHECK (lifecycle IN ('active', 'retired')),
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
-- idempotency lookup (github-pr-import.server.ts) is an indexed read on it.
CREATE INDEX IF NOT EXISTS nodes_ref_locator_idx ON nodes (doco_id, locator) WHERE node_type = 'reference';

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
  -- 'actor' = the human approved an "act as me" credential: the minted
  -- refresh token carries NO explicit grants and resolves the user's LIVE
  -- workspace membership (one workspace per access token) at refresh time.
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
  -- 'actor' = a user-level credential whose breadth is the user's LIVE
  -- workspace membership (resolved at exchange), down-scoped to ONE workspace
  -- per access token via the RFC 8707 `resource`. 'regular' (default) = a
  -- single-workspace refresh whose grants copy through to the access token
  -- verbatim. An actor refresh carries NO explicit workspace/doco grants.
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
  -- See oauth_authorization_codes.grant_type — same 'regular'/'actor' meaning;
  -- the polling endpoint copies this onto the minted refresh token.
  grant_type       text NOT NULL DEFAULT 'regular'
                     CHECK (grant_type IN ('regular', 'actor')),
  -- See oauth_authorization_codes.actor_role — the role ceiling carried onto the
  -- minted refresh token. NULL = owner (full live role).
  actor_role       text CHECK (actor_role IS NULL OR actor_role IN ('reader','writer','owner')),
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
  kind            text NOT NULL CHECK (kind IN ('graph','list','process','org-tree','sla','glossary','pull-requests','slack')),
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

-- An attachment belongs to the principal who uploaded it, not to a single
-- thread: the composer uploads the bytes before the turn picks which
-- conversation to run on (rolling vs. Doco-scoped), so any lookup must key on
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

-- ── Slack public-channel mirror ─────────────────────────────────────────
-- A Doco can be a read-only copy of a Slack team's PUBLIC channels, kept in
-- sync. Never DMs, private channels, or Slack Connect channels shared with
-- another organization. Files are kept as links, never bytes.
--
-- Deliberately NOT `nodes`: a message deleted in Slack (or the whole copy, on
-- uninstall) must really disappear, and a Slack team runs to millions of
-- messages, while nodes are append-only, policy-checked graph knowledge. Every
-- mirror row cascades from the mirror, which cascades from BOTH its Doco and
-- its Slack installation, so deleting either wipes the copy.

-- One row per mirroring Doco: "this Doco mirrors that Slack team".
CREATE TABLE IF NOT EXISTS group_chat_mirrors (
  doco_id          text PRIMARY KEY REFERENCES docos(id) ON DELETE CASCADE,
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
  doco_id          text NOT NULL REFERENCES group_chat_mirrors(doco_id) ON DELETE CASCADE,
  channel_id       text NOT NULL,                    -- Slack C…
  name             text NOT NULL,
  topic            text NOT NULL DEFAULT '',
  purpose          text NOT NULL DEFAULT '',
  archived         boolean NOT NULL DEFAULT false,
  -- The owner opted this channel out: nothing from it is copied. Kept as a row
  -- so channel discovery doesn't add it back.
  excluded         boolean NOT NULL DEFAULT false,
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
  PRIMARY KEY (doco_id, channel_id)
);

CREATE TABLE IF NOT EXISTS group_chat_messages (
  doco_id      text NOT NULL,
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
  -- 'simple' (no stemming): exact-term lookups in any language; meaning-based
  -- retrieval is the embeddings' job.
  search_tsv   tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
  PRIMARY KEY (doco_id, channel_id, ts),
  FOREIGN KEY (doco_id, channel_id) REFERENCES group_chat_channels (doco_id, channel_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS group_chat_messages_thread_idx
  ON group_chat_messages (doco_id, channel_id, thread_ts, ts) WHERE thread_ts IS NOT NULL;
CREATE INDEX IF NOT EXISTS group_chat_messages_posted_idx
  ON group_chat_messages (doco_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS group_chat_messages_tsv_idx
  ON group_chat_messages USING gin (search_tsv);

-- A mirror Doco stays private: its channels are visible only to members of
-- that Slack team, never to the internet. Enforced here, not per route, so no
-- settings surface (UI, API, agent) can publish one.
CREATE OR REPLACE FUNCTION doco_mirror_stays_private() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'docos' THEN
    IF NEW.visibility <> 'private'
       AND EXISTS (SELECT 1 FROM group_chat_mirrors WHERE doco_id = NEW.id) THEN
      RAISE EXCEPTION 'A Slack mirror Doco must stay private.';
    END IF;
  ELSIF (SELECT visibility FROM docos WHERE id = NEW.doco_id) <> 'private' THEN
    RAISE EXCEPTION 'Only a private Doco can mirror Slack.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS docos_mirror_stays_private ON docos;
CREATE TRIGGER docos_mirror_stays_private
  BEFORE UPDATE OF visibility ON docos
  FOR EACH ROW EXECUTE FUNCTION doco_mirror_stays_private();
DROP TRIGGER IF EXISTS group_chat_mirrors_private_doco ON group_chat_mirrors;
CREATE TRIGGER group_chat_mirrors_private_doco
  BEFORE INSERT OR UPDATE OF doco_id ON group_chat_mirrors
  FOR EACH ROW EXECUTE FUNCTION doco_mirror_stays_private();

-- Slack people, so the mirror shows names without a users.info call per message.
CREATE TABLE IF NOT EXISTS group_chat_members (
  doco_id       text NOT NULL REFERENCES group_chat_mirrors(doco_id) ON DELETE CASCADE,
  chat_user_id  text NOT NULL,
  display_name  text NOT NULL DEFAULT '',
  real_name     text NOT NULL DEFAULT '',
  avatar_url    text,
  is_bot        boolean NOT NULL DEFAULT false,
  deactivated   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (doco_id, chat_user_id)
);

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

-- ──────────────────────────────────────────────────────────────────────────
-- Column backfills. A column added inline to a `CREATE TABLE IF NOT EXISTS`
-- above does NOT alter a table that already exists — the CREATE is a no-op on
-- re-boot — so a column introduced after a table first shipped must be added
-- explicitly here. Idempotent (ADD COLUMN IF NOT EXISTS), re-asserted on every
-- cold start; a no-op once the column is present (incl. on a fresh DB, where
-- the CREATE TABLE already made it). The CHECK matches the inline definition.
-- Soft-delete tombstone for Docos created before the column shipped. The
-- partial sweeper index lives HERE, after the ADD COLUMN — not in the docos
-- table block above — because schema.sql re-applies top-to-bottom on every
-- boot: on a pre-existing docos table the inline CREATE TABLE is a no-op, so an
-- index that referenced `deleted_at` earlier in the file would hit a column
-- that this migration hasn't added yet and abort the entire schema-apply.
ALTER TABLE docos
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS docos_deleted_at_idx ON docos (deleted_at) WHERE deleted_at IS NOT NULL;

ALTER TABLE oauth_authorization_codes
  ADD COLUMN IF NOT EXISTS actor_role text
  CHECK (actor_role IS NULL OR actor_role IN ('reader','writer','owner'));
ALTER TABLE oauth_refresh_tokens
  ADD COLUMN IF NOT EXISTS actor_role text
  CHECK (actor_role IS NULL OR actor_role IN ('reader','writer','owner'));
ALTER TABLE oauth_device_authorizations
  ADD COLUMN IF NOT EXISTS actor_role text
  CHECK (actor_role IS NULL OR actor_role IN ('reader','writer','owner'));

-- Untie chat_attachments from a single conversation. The composer uploads
-- bytes before the turn knows which thread it runs on, so keying the row to a
-- conversation dropped the file whenever the upload thread and the message
-- thread differed (a Doco page's first message). Attachments are owned by the
-- principal now; reads filter on user_id. Drop the conversation index first
-- (it depends on the column), then the column itself.
DROP INDEX IF EXISTS idx_chat_attachments_conversation;
ALTER TABLE chat_attachments DROP COLUMN IF EXISTS conversation_id;

-- Slack mirror history backfill (added after the mirror tables first shipped).
ALTER TABLE group_chat_mirrors ADD COLUMN IF NOT EXISTS channels_synced_at timestamptz;
ALTER TABLE group_chat_mirrors ADD COLUMN IF NOT EXISTS history_next_at timestamptz;
ALTER TABLE group_chat_mirrors ADD COLUMN IF NOT EXISTS replies_next_at timestamptz;
ALTER TABLE group_chat_channels ADD COLUMN IF NOT EXISTS history_oldest_ts text;
ALTER TABLE group_chat_messages ADD COLUMN IF NOT EXISTS replies_cursor text;
-- Thread roots whose earlier replies the backfill still has to fetch.
CREATE INDEX IF NOT EXISTS group_chat_messages_replies_pending_idx
  ON group_chat_messages (doco_id) WHERE reply_count > 0 AND replies_synced_at IS NULL;

-- The Slack perspective (a Slack-mirror Doco's channel reader). Its kind joins
-- the perspectives CHECK here, before its built-in row, because on an existing
-- database the inline CHECK above is a no-op and the old constraint would
-- reject the row and abort the schema apply.
ALTER TABLE perspectives DROP CONSTRAINT IF EXISTS perspectives_kind_check;
ALTER TABLE perspectives ADD CONSTRAINT perspectives_kind_check
  CHECK (kind IN ('graph','list','process','org-tree','sla','glossary','pull-requests','slack'));
INSERT INTO perspectives (id, slug, kind, name, description, icon, owner_handle, is_builtin, config) VALUES
  ('perspective_slack','slack','slack','Slack','A mirrored Slack workspace''s public channels: messages, threads, and search.','💬',NULL,true,'{}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- Actor access tokens act as their user, capped at actor_role, resolved live —
-- so the access token (not just the refresh token) carries the actor marker.
ALTER TABLE oauth_access_tokens
  ADD COLUMN IF NOT EXISTS grant_type text NOT NULL DEFAULT 'regular'
  CHECK (grant_type IN ('regular', 'actor'));
ALTER TABLE oauth_access_tokens
  ADD COLUMN IF NOT EXISTS actor_role text
  CHECK (actor_role IS NULL OR actor_role IN ('reader','writer','owner'));

-- ──────────────────────────────────────────────────────────────────────────
-- account_grants retirement. The live person-to-person "all my workspaces,
-- including ones I create later" delegation is gone: that breadth now lives
-- ONLY on tokens (the actor / mint-time snapshot paths). A grant to another
-- PERSON must name concrete, existing targets, so the table is dropped. To
-- avoid silently revoking access, first convert every surviving grant into the
-- memberships it currently confers — a snapshot of the grantor's owned
-- workspaces and personally-owned docos (the access cascade is now pure
-- workspace_users + doco_users). Guarded + self-removing: runs once on the
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

    INSERT INTO doco_users (doco_id, user_id, role, write_types)
    SELECT d.id, ag.grantee_user_id, ag.role, ag.write_types
      FROM account_grants ag
      JOIN docos d ON d.owner_id = ag.grantor_user_id
    ON CONFLICT (doco_id, user_id) DO NOTHING;

    DROP TABLE account_grants;
  END IF;
END $$;
