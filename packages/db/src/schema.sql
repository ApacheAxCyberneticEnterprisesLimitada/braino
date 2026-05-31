-- Doco Postgres schema (decision_01KRKEVEE3RQGPWHAPMZ0MS9G9).
--
-- Source-of-truth + read-side index in one database per host.
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
--   - `edges` materializes relationships between nodes for graph queries.
--   - `audit_events` is the structured history (decision_01KRKESCBTYG4005VMPKYNYR53).
--   - New schema changes belong in packages/db/migrations/.
--
-- Vocabulary (post-migration-005):
--   nodes   — graph entities (10 types: intent/idea/rule/decision/action/
--               log/eval/reference/state/principal)
--   policies — Doco-level authoring metadata (2 kinds: guidance / node_authoring)
--   edges   — relationships between nodes
--   users      — OAuth identities (person/agent), separate from principals
--                (which are role-personas referenced by actor_id/actors[]).

-- Forward-only migration ledger. Populated by `applyMigrations()` in
-- packages/db/src/migrations.ts. New schema changes go in
-- `packages/db/migrations/NNN_short_name.sql`, not into this file.
CREATE TABLE IF NOT EXISTS applied_migrations (
  id          text PRIMARY KEY
);

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
--   `users`      — OAuth identity (person or agent runtime that holds
--                  auth tokens). Authored nodes via `created_by` /
--                  `updated_by`. Members of orgs/docos. Agent users are
--                  owned by an organization; person users are unowned.
--   `principals` — role-personas (the "actor" in a documented business
--                  process). Referenced by Action.actor_id, Log.actor_id,
--                  Intent.actors[], etc. Modeled as a node type.

CREATE TABLE IF NOT EXISTS users (
  id              text PRIMARY KEY,            -- user_<ulid>
  kind            text NOT NULL CHECK (kind IN ('person', 'agent')),
  github_id       text,                        -- GitHub numeric id (immutable)
  github_login    text,                        -- current GitHub login (mutable)
  email           text,
  avatar_url      text,
  owner_id        text REFERENCES users(id) ON DELETE SET NULL,
  data            jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deactivated_at  timestamptz
);
CREATE INDEX IF NOT EXISTS users_github_login_idx ON users (github_login);
CREATE INDEX IF NOT EXISTS users_kind_idx          ON users (kind);
CREATE INDEX IF NOT EXISTS users_owner_idx         ON users (owner_id);


CREATE TABLE IF NOT EXISTS organizations (
  id          text PRIMARY KEY,
  handle      text NOT NULL UNIQUE,
  name        text NOT NULL,
  -- Free-form governing charter for the org — the standing "how work is
  -- done here" text shared with every agent granted access to the org at
  -- bootstrap, and shown on the org home page. Column default is ''; the
  -- real default text (DEFAULT_ORG_CONSTITUTION in @doco/shared) is applied
  -- by addOrganizationByHandle for new orgs and backfilled onto existing
  -- rows by migration 069_org_constitution.sql.
  constitution text NOT NULL DEFAULT '',
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Organization users (per-org role grants).
CREATE TABLE IF NOT EXISTS org_users (
  org_id        text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner', 'writer', 'reader')),
  -- Per-type write grants (migration 062). '*' = write every type;
  -- owners ignore this and write everything.
  write_types   text[] NOT NULL DEFAULT ARRAY[]::text[],
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
-- org_users_user_idx lives in migration 055: the baseline must not
-- reference user_id on an existing prod org_users (still collaborator_id)
-- until 055 renames the column.

-- Every Doco has a single public `handle`. It lives in the same flat
-- namespace as top-level host routes. The internal ULID `id` stays as
-- the FK target for entity tables; `handle` is what URLs and public API
-- calls use.
CREATE TABLE IF NOT EXISTS docos (
  id              text PRIMARY KEY,
  handle          text NOT NULL UNIQUE,
  owner_id        text NOT NULL,    -- organization_<ulid>
  org_id          text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  visibility      text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  allowed_node_types text[],
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

-- Per-Doco entity tables. `body_md` carries the markdown narrative
-- on types that have one; the remaining structured fields live in
-- `data` (jsonb). Scalar ID refs are promoted to typed FK columns
-- (e.g. actions.actor_id → principals(id)).



-- rules.kind / rules.severity indexes live in migration 035 alongside the
-- ALTER TABLE that adds the columns — putting them here means schema.sql
-- (which runs BEFORE migrations) tries to index columns that don't exist
-- on an existing prod table yet, taking the deploy down.

CREATE TABLE IF NOT EXISTS guidance_policies (
  id          text PRIMARY KEY,
  doco_id     text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  -- One-line rule statement. Renamed from `summary` to `policy` in
  -- migration 038 to match the migration-023 type-named-prose pattern
  -- the 9 node types use.
  policy      text,
  lifecycle   text,
  body_md     text,
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
CREATE INDEX IF NOT EXISTS guidance_policies_doco_idx
  ON guidance_policies (doco_id, created_at DESC);
CREATE INDEX IF NOT EXISTS guidance_policies_lifecycle_idx
  ON guidance_policies (doco_id, lifecycle);

CREATE TABLE IF NOT EXISTS node_authoring_policies (
  id          text PRIMARY KEY,
  doco_id     text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  -- See guidance_policies.policy — same rename.
  policy      text,
  lifecycle   text,
  body_md     text,
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
CREATE INDEX IF NOT EXISTS node_authoring_policies_doco_idx
  ON node_authoring_policies (doco_id, created_at DESC);
CREATE INDEX IF NOT EXISTS node_authoring_policies_lifecycle_idx
  ON node_authoring_policies (doco_id, lifecycle);

-- actions.verb / actions.performed_at indexes live in migration 035 — see
-- the note above the rules block.

-- logs.verb / logs.happened_at indexes live in migration 035.

-- evals.kind index lives in migration 035.

-- State is a node in a
-- formal state machine. Mirrors the actions table shape; the structured
-- fields (`kind`, `invariants`) live in `data`.
-- states.kind index lives in migration 035.

-- reference_entities.ref_type index lives in migration 035.

-- ── Unified node table (doco-vnext follow-up: collapse the 10 per-type
--    node tables into one) ───────────────────────────────────────────────
-- One row per graph node of ANY type, discriminated by `node_type`. Replaces
-- the 10 per-type tables (intents/decisions/rules/actions/logs/evals/states/
-- ideas/reference_entities/principals) — the sharding was a false split; this
-- mirrors how `edges` is already a single discriminated table.
--
-- "Wide" by design: per-type promoted SCALAR columns are preserved here as
-- real (nullable) columns so reads keep their existing column names. The five
-- promoted node→node relationship columns (parent_intent_id, decided_by,
-- superseded_by_decision_id, actor_id, template_id) were DROPPED by migration
-- 074 (option (i): edges as the authored source of truth) — each relationship
-- now lives on the `edges` table (FK'd to nodes(id)), with the authored value
-- still carried in `data`. `proposer_id` stays a column: it points at
-- `users(id)` (the OAuth identity that proposed the idea, not a node), so it is
-- not expressible as a node→node edge. The `edges` table likewise FKs from_id /
-- to_id to nodes(id): edges connect nodes only; org/doco containment rides on
-- the doco_id / org_id columns, never on a graph edge. The
-- migration that copies the legacy rows in is 064; the legacy tables are
-- dropped in a later migration once this is production-verified.
--
-- Policies are deliberately NOT folded in here: guidance_policies /
-- node_authoring_policies stay their own tables (governance config, not graph
-- knowledge). They share the node_versions spine, so any rebuild-from-spine
-- MUST filter entity_type to the node types below.
CREATE TABLE IF NOT EXISTS nodes (
  id             text PRIMARY KEY,            -- <node_type>_<ulid>
  doco_id        text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  node_type      text NOT NULL,              -- intent|idea|rule|decision|action|log|eval|reference|state|principal
  lifecycle      text,
  prose          text NOT NULL DEFAULT '',   -- unified type-named column for the 9 prose node types; empty string for principals
  name           text,                       -- principal display label (NULL for the others)
  body_md        text,                       -- principal prose description (NULL for the others)
  role_principal boolean NOT NULL DEFAULT false,
  -- The five node→node relationship columns were dropped by migration 074:
  -- each (intent→intent parent, decision→principal decider, decision→decision
  -- supersession, action/log→principal actor, log→action template) is now a
  -- first-class `edges` row (origin='field'), authored by the capture path.
  -- `proposer_id` stays — it points at users(id) (the OAuth identity that
  -- proposed the idea, not a node), so it is not a node→node edge; ON DELETE
  -- SET NULL (a deleted user just drops the credit).
  proposer_id               text CONSTRAINT nodes_proposer_fk               REFERENCES users(id) ON DELETE SET NULL,             -- idea → users(id) (OAuth identity)
  -- Promoted scalar columns (migration 035 lineage).
  verb         text,                          -- action, log
  performed_at timestamptz,                   -- action (matches actions.performed_at)
  happened_at  timestamptz,                   -- log (matches logs.happened_at)
  kind         text,                          -- eval, state
  modality     text,                          -- rule
  severity     text,                          -- rule
  phase        text,                          -- rule
  on_violation text,                          -- rule
  ref_type     text,                          -- reference
  locator      text,                          -- reference
  citation     text,                          -- reference
  title        text,                          -- reference
  data         jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text
);
CREATE INDEX IF NOT EXISTS nodes_doco_type_idx  ON nodes (doco_id, node_type, created_at DESC);
CREATE INDEX IF NOT EXISTS nodes_doco_life_idx  ON nodes (doco_id, lifecycle);
-- nodes_superseded_idx / nodes_actor_idx removed with their columns (migration
-- 074): the relationships are queried via the `edges` table now.

-- Audit events: one row per mutation.

CREATE TABLE IF NOT EXISTS audit_events (
  event_id      text PRIMARY KEY,
  at            timestamptz NOT NULL,
  by_user       text,
  doco_id       text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
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
-- audit_events_user_idx lives in migration 055 (renamed-column index;
-- baseline must not reference by_user before 055 renames by_collaborator).

-- Org-scope audit events. For those rows, `org_id` is set and `doco_id`
-- is NULL.
ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE audit_events ALTER COLUMN doco_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS audit_events_org_idx ON audit_events (org_id, at DESC);

-- ──────────────────────────────────────────────────────────────────────────
-- Append-only history (doco-vnext). The commit log + immutable version
-- snapshots are the SOURCE OF TRUTH; the per-type node tables and `edges`
-- are a rebuildable projection. Nothing is ever deleted — removal is a
-- `retire` version. See docs/plans/doco-vnext.md.

-- Commit log — one row per atomic changeset (Git's commit). Carries
-- who/when/WHY. tx_id is a global monotonic sequence enabling whole-graph
-- "as-of" reads. Append-only; never updated or deleted (see migration 063
-- which REVOKEs UPDATE/DELETE on the history tables from the app role).
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
  tx_id        bigint NOT NULL REFERENCES changesets(tx_id),
  actor        text,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  prev_hash    text,                          -- Merkle hash chain (see verifyHistory in vnext.ts)
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
  tx_id        bigint NOT NULL REFERENCES changesets(tx_id),
  actor        text,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  prev_hash    text,
  this_hash    text,
  PRIMARY KEY (entity_id, version)
);
CREATE INDEX IF NOT EXISTS edge_versions_tx_idx   ON edge_versions (tx_id);
CREATE INDEX IF NOT EXISTS edge_versions_asof_idx ON edge_versions (entity_id, tx_id);

-- Indexing layer tables. These hold the derived-data the read side
-- consumes — graph edges, vector embeddings, denormalized rule targets,
-- and full-text search rows. Supersedes ADR-023 (tiered architecture)
-- and ADR-024 (SQLite + FTS5) — Postgres is now both source of truth
-- and read-side index.

-- Graph edges — FIRST-CLASS entities (doco-vnext). Each edge is its own
-- row with a surrogate id (edge_<ulid>), lifecycle, and provenance — a
-- peer of nodes, NOT a derived cache. Endpoints can be any node type so
-- we can't FK them; existence + same-doco is enforced in app code.
-- Mutated by edge CRUD via commit() (origin='authored', carrying provenance)
-- and reconciled by the capture path from node relationship fields
-- (origin='field'); the indexer never wipes/rebuilds this table. Removal is
-- lifecycle='retired', never DELETE.
CREATE TABLE IF NOT EXISTS edges (
  id              text PRIMARY KEY,           -- edge_<ulid>
  doco_id         text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  edge_type       text NOT NULL,
  from_id         text NOT NULL CONSTRAINT edges_from_fk REFERENCES nodes(id) DEFERRABLE INITIALLY DEFERRED,
  from_node_type  text NOT NULL,
  to_id           text NOT NULL CONSTRAINT edges_to_fk   REFERENCES nodes(id) DEFERRABLE INITIALLY DEFERRED,
  to_node_type    text NOT NULL,
  props           jsonb,
  lifecycle       text NOT NULL DEFAULT 'asserted',
  -- How this edge came to exist (option (i): edges as the authored source of
  -- truth). 'authored' = created directly via the edges API (captureEdge),
  -- carrying its own provenance/history. 'field' = projected by the capture
  -- path from a node relationship field (e.g. a Decision's decided_by) and
  -- reconciled on every re-capture of that node. Only 'field' edges are
  -- reconciled; 'authored' edges are never auto-retired.
  origin          text NOT NULL DEFAULT 'authored'
                    CHECK (origin IN ('authored','field')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text,                       -- user_<ulid>
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      text,
  retired_at      timestamptz
);
-- At most one LIVE edge per (doco, from, to, type); retired duplicates ok.
CREATE UNIQUE INDEX IF NOT EXISTS edges_live_uniq
  ON edges (doco_id, from_id, to_id, edge_type) WHERE lifecycle <> 'retired';
CREATE INDEX IF NOT EXISTS edges_doco_idx           ON edges (doco_id);
CREATE INDEX IF NOT EXISTS edges_doco_type_from_idx ON edges (doco_id, edge_type, from_id);
CREATE INDEX IF NOT EXISTS edges_doco_type_to_idx   ON edges (doco_id, edge_type, to_id);
CREATE INDEX IF NOT EXISTS edges_from_idx           ON edges (from_id);
CREATE INDEX IF NOT EXISTS edges_to_idx             ON edges (to_id);
CREATE INDEX IF NOT EXISTS edges_lifecycle_idx      ON edges (doco_id, lifecycle);

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

-- Full-text search. Only nodes are indexed (entity_fts_nodes): the indexer
-- populates summary + body, and Slack search — the lone reader — queries the
-- generated `search_tsv` tsvector (English stemming, weighted A=summary,
-- B=body) through a GIN index for `@@` queries. The policy / user / doco /
-- organization FTS tables were never read and were dropped (migrations 071/073).

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

-- (entity_fts_policies dropped in migration 073 — written but never read.)

-- ──────────────────────────────────────────────────────────────────────────
-- Multi-level access (decision_01KS0JBJ5X0AZ4XJJFKEWE1R62).
--
-- Three roles (owner / writer / reader) granted at two levels
-- (org / doco). Effective role = max across levels (highest-wins
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
  -- Per-type write grants (migration 062). '*' = write every type;
  -- owners ignore this and write everything.
  write_types   text[] NOT NULL DEFAULT ARRAY[]::text[],
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doco_id, user_id)
);
-- doco_users_user_idx lives in migration 055 (renamed-column index).

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
  code_challenge        text NOT NULL,
  code_challenge_method text NOT NULL DEFAULT 'S256' CHECK (code_challenge_method = 'S256'),
  granted_doco_ids      text[] NOT NULL,
  -- Per-Doco role scope-down. Map of doco_id → DocoRole capping the
  -- token's effective role on that Doco. The user can lower the role
  -- below what they themselves hold (give the agent "reader" on a Doco
  -- where they're owner) but never raise it. Missing entries mean
  -- "inherit the principal's actual role" — i.e. no scope-down.
  granted_doco_roles    jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Per-type write scope-down (migration 062), keyed by doco_id →
  -- list of writable-type tokens ('*' = all). Parallels granted_doco_roles.
  granted_doco_write_types jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Org-level grants. When the user approves access to an org, every
  -- Doco owned by that org becomes reachable through this token —
  -- including Docos created under the org after the token was minted
  -- ("live" grant, not a snapshot). `granted_org_roles[org_id]` caps
  -- the effective role on Docos under that org, same semantics as
  -- granted_doco_roles.
  granted_org_ids       text[] NOT NULL DEFAULT ARRAY[]::text[],
  granted_org_roles     jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_org_write_types jsonb NOT NULL DEFAULT '{}'::jsonb,
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
  granted_doco_ids  text[] NOT NULL,
  granted_doco_roles jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_doco_write_types jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_org_ids   text[] NOT NULL DEFAULT ARRAY[]::text[],
  granted_org_roles jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_org_write_types jsonb NOT NULL DEFAULT '{}'::jsonb,
  scope             text,
  expires_at        timestamptz NOT NULL,
  revoked           boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- oauth_access_tokens_user_idx lives in migration 055 (renamed-column index).
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
  user_id           text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_doco_ids  text[] NOT NULL,
  granted_doco_roles jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_doco_write_types jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_org_ids   text[] NOT NULL DEFAULT ARRAY[]::text[],
  granted_org_roles jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_org_write_types jsonb NOT NULL DEFAULT '{}'::jsonb,
  scope             text,
  expires_at        timestamptz NOT NULL,
  revoked           boolean NOT NULL DEFAULT false,
  superseded_by     text REFERENCES oauth_refresh_tokens(token) ON DELETE SET NULL,
  -- Non-rotating tokens skip rotation on refresh so they can be pinned
  -- into a cloud environment's variable config (see migration 058).
  non_rotating      boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- oauth_refresh_tokens_user_idx lives in migration 055 (renamed-column index).
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
  granted_doco_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  granted_doco_roles jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_doco_write_types jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_org_ids  text[] NOT NULL DEFAULT ARRAY[]::text[],
  granted_org_roles jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_org_write_types jsonb NOT NULL DEFAULT '{}'::jsonb,
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

-- Non-rotating refresh tokens for cloud-environment use (migration 058).
-- Same IF NOT EXISTS guard for idempotent boot against existing deployments.
ALTER TABLE oauth_refresh_tokens
  ADD COLUMN IF NOT EXISTS non_rotating boolean NOT NULL DEFAULT false;

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
    CHECK (requested_role IS NULL OR requested_role IN ('reader','writer','owner'));

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
-- Tables folded into the baseline from the (now-archived) migration chain by
-- the doco-vnext squash. Previously created incrementally by migrations; the
-- genesis reset rebuilds from this baseline alone, so they must live here.
-- Column names are the final post-055 (user, not collaborator) form.

-- Visualization perspectives (was migrations 007 + 030/046/051/059) and the
-- per-Doco attachment join. Ownership is tracked by `owner_handle`; the
-- unused `owner_user_id` column was dropped in migration 071.
CREATE TABLE IF NOT EXISTS perspectives (
  id              text PRIMARY KEY,
  slug            text NOT NULL UNIQUE,
  kind            text NOT NULL CHECK (kind IN ('graph','list','bpmn','org-tree','sla','approval','glossary')),
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

-- Built-in perspectives. host.ts attaches graph/list/for-approval to every new
-- Doco, so these rows must exist for doco creation to succeed.
INSERT INTO perspectives (id, slug, kind, name, description, icon, owner_handle, is_builtin, config) VALUES
  ('perspective_graph','graph','graph','Graph','Force-directed overview of nodes and edges — the original view.','🕸️',NULL,true,'{}'::jsonb),
  ('perspective_list','list','list','List','Sortable list of nodes, with type-aware tiebreakers.','📋',NULL,true,'{"default_sort":"recent_desc"}'::jsonb),
  ('perspective_bpmn','bpmn','bpmn','BPMN','Business process modeling — swim lanes, gateways, and events. Inspired by BPMN.','🏭','torrenegra',true,'{"lane_axis":"principal"}'::jsonb),
  ('perspective_approval','for-approval','approval','Proposed','Queue of proposed nodes waiting for review.',NULL,NULL,true,'{"lifecycle":"drafting","reject_lifecycle":"drafting","approve_lifecycle":"asserted"}'::jsonb),
  ('perspective_glossary','glossary','glossary','Glossary','A dictionary-style reading of the Doco''s terminology — canonical headwords, definitions, senses, and aliases laid out like a printed lexicon.','📖',NULL,true,'{"headword_field":"chosen","primary_entity":"decision","definition_field":"decision"}'::jsonb),
  ('perspective_org_tree','org-tree','org-tree','Org Tree','Organizational chart — Principals as members, `reports_to` edges as reporting lines, with person vs AI agent shown by icon.','🏢',NULL,true,'{"agent_icon":"🤖","person_icon":"👤","root_edge":"reports_to","icon_by_member_kind":true}'::jsonb),
  ('perspective_sla','sla','sla','SLAs','Service-level agreement control plane — commitments, owners, evidence links, remedies, and review gaps.','📜',NULL,true,'{"event_logs":false,"primary_entity":"rule","evidence_sources":["eval","reference"]}'::jsonb)
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

-- In-page assistant chat (was migrations 003/004/008/009/024/031/032).
CREATE TABLE IF NOT EXISTS chat_conversations (
  id                       text PRIMARY KEY,
  user_id                  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  archived                 boolean NOT NULL DEFAULT false,
  active_turn_started_at   timestamptz,
  active_turn_events       jsonb NOT NULL DEFAULT '[]'::jsonb,
  title                    text,
  attached_doco_handles    text[] NOT NULL DEFAULT '{}',
  attached_org_handles     text[] NOT NULL DEFAULT '{}',
  attached_doco_ids        text[] NOT NULL DEFAULT '{}',
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
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

-- Telemetry (was migration 017). user_id / doco_id are plain text (no FK).
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

-- OpenAI usage log (was migration 025).
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

-- Group-chat integrations (was migration 047). *_user_id are post-055.
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
  target_level            text NOT NULL CHECK (target_level IN ('org','doco')),
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

-- Feedback reports (was migration 048).
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
-- Self-heal columns promoted from `data` jsonb by migrations (013/025/035/056)
-- that pre-date this squashed baseline. CREATE TABLE IF NOT EXISTS above won't
-- add them to a DB that already has the table (e.g. a prod that genesis-reset
-- from an earlier, incomplete baseline), so add them here idempotently — the
-- same belt-and-suspenders pattern as the oauth_* ADD COLUMN block above.

-- ──────────────────────────────────────────────────────────────────────────
-- Append-only guardrails (doco-vnext). The commit log + version snapshots are
-- immutable: block UPDATE / DELETE / TRUNCATE on them at the DB level, for
-- EVERY role including superuser — stronger than REVOKE, which superusers
-- bypass. Inserts are allowed; "removal" is a retire VERSION, never a delete.
-- The genesis reset uses DROP TABLE (DDL), which these triggers do not block,
-- so the bookend rebuild still works. Idempotent (CREATE OR REPLACE + DROP IF
-- EXISTS), so it re-asserts on every cold start.
CREATE OR REPLACE FUNCTION doco_block_history_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'doco-vnext: % on % is not allowed — history is append-only', TG_OP, TG_TABLE_NAME;
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
