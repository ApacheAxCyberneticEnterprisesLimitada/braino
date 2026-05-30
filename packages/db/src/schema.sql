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

-- Schema version. Tracked separately from app version so DB migrations
-- don't gate code releases.
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

CREATE TABLE IF NOT EXISTS principals (
  id              text PRIMARY KEY,            -- principal_<ulid>
  -- Principals are Doco-scoped (migration 020). The FK + NOT NULL are
  -- added by 020 after the docos table exists; declared nullable here
  -- only so the schema baseline parses before docos is created later in
  -- this file. Names are descriptive labels, not unique keys.
  doco_id         text,
  name            text NOT NULL,                -- display label (e.g. "System",
                                                -- "Customer service rep")
  lifecycle       text,
  -- Prose body. Carries the entire Principal narrative after the
  -- slim-down — the `summary` one-liner column was dropped by
  -- migration 037 (per "Principal should not use summary").
  body_md         text,
  -- Legacy role-principal flag. Promoted out of `data` jsonb by
  -- migration 035; new Principal creation no longer sets this from
  -- reserved names.
  role_principal  boolean NOT NULL DEFAULT false,
  data            jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text,                        -- user_<ulid>
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      text
);

CREATE TABLE IF NOT EXISTS organizations (
  id          text PRIMARY KEY,
  handle      text NOT NULL UNIQUE,
  name        text NOT NULL,
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

CREATE TABLE IF NOT EXISTS intents (
  id          text PRIMARY KEY,
  doco_id     text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  lifecycle   text,
  -- Type-named prose column (post-rename). Holds all the prose; the
  -- legacy headline/body/title trio was collapsed by migrations 022
  -- and 023. Structural data (actors, wanted_by, ...) lives in `data`.
  intent      text NOT NULL DEFAULT '',
  data        jsonb NOT NULL,
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
  lifecycle   text,
  decision    text NOT NULL DEFAULT '',  -- see intents.intent
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
CREATE INDEX IF NOT EXISTS decisions_doco_idx ON decisions (doco_id, created_at DESC);
CREATE INDEX IF NOT EXISTS decisions_lifecycle_idx ON decisions (doco_id, lifecycle);

CREATE TABLE IF NOT EXISTS rules (
  id            text PRIMARY KEY,
  doco_id       text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  lifecycle     text,
  rule          text NOT NULL DEFAULT '',  -- see intents.intent
  -- Enum-shaped scalars promoted out of data jsonb by migration 035.
  -- `predicate`, `expected`, `applies_to` stay in `data` (compound).
  kind          text,
  modality      text,
  severity      text,
  phase         text,
  on_violation  text,
  data          jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text
);
CREATE INDEX IF NOT EXISTS rules_doco_idx ON rules (doco_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rules_lifecycle_idx ON rules (doco_id, lifecycle);
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

CREATE TABLE IF NOT EXISTS actions (
  id            text PRIMARY KEY,
  doco_id       text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  lifecycle     text,
  action        text NOT NULL DEFAULT '',  -- see intents.intent
  -- Scalars promoted out of data jsonb by migration 035.
  verb          text,
  performed_at  timestamptz,
  data          jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text
);
CREATE INDEX IF NOT EXISTS actions_doco_idx ON actions (doco_id, created_at DESC);
CREATE INDEX IF NOT EXISTS actions_lifecycle_idx ON actions (doco_id, lifecycle);
-- actions.verb / actions.performed_at indexes live in migration 035 — see
-- the note above the rules block.

CREATE TABLE IF NOT EXISTS logs (
  id           text PRIMARY KEY,
  doco_id      text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  lifecycle    text,
  log          text NOT NULL DEFAULT '',  -- see intents.intent
  -- Scalars promoted out of data jsonb by migration 035.
  verb         text,
  happened_at  timestamptz,
  data         jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text
);
CREATE INDEX IF NOT EXISTS logs_doco_idx ON logs (doco_id, created_at DESC);
CREATE INDEX IF NOT EXISTS logs_lifecycle_idx ON logs (doco_id, lifecycle);
-- logs.verb / logs.happened_at indexes live in migration 035.

CREATE TABLE IF NOT EXISTS evals (
  id          text PRIMARY KEY,
  doco_id     text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  lifecycle   text,
  eval        text NOT NULL DEFAULT '',  -- see intents.intent (also folded in: name, description)
  kind        text,                       -- scalar promoted by migration 035
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
CREATE INDEX IF NOT EXISTS evals_doco_idx ON evals (doco_id, created_at DESC);
CREATE INDEX IF NOT EXISTS evals_lifecycle_idx ON evals (doco_id, lifecycle);
-- evals.kind index lives in migration 035.

-- State is a node in a
-- formal state machine. Mirrors the actions table shape; the structured
-- fields (`kind`, `invariants`) live in `data`.
CREATE TABLE IF NOT EXISTS states (
  id          text PRIMARY KEY,
  doco_id     text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  lifecycle   text,
  state       text NOT NULL DEFAULT '',  -- see intents.intent
  kind        text,                       -- scalar promoted by migration 035
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
CREATE INDEX IF NOT EXISTS states_doco_idx ON states (doco_id, created_at DESC);
CREATE INDEX IF NOT EXISTS states_lifecycle_idx ON states (doco_id, lifecycle);
-- states.kind index lives in migration 035.

CREATE TABLE IF NOT EXISTS tags (
  id          text PRIMARY KEY,
  doco_id     text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  name        text NOT NULL,
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doco_id, name)
);

CREATE TABLE IF NOT EXISTS ideas (
  id          text PRIMARY KEY,
  doco_id     text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  lifecycle   text,
  idea        text NOT NULL DEFAULT '',  -- see intents.intent
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

CREATE TABLE IF NOT EXISTS reference_entities (
  id          text PRIMARY KEY,
  doco_id     text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  lifecycle   text,
  reference   text NOT NULL DEFAULT '',  -- see intents.intent
  -- Scalars promoted out of data jsonb by migration 035.
  ref_type    text,
  locator     text,
  citation    text,
  title       text,
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
-- reference_entities.ref_type index lives in migration 035.

-- Audit events: one row per mutation.

CREATE TABLE IF NOT EXISTS audit_events (
  event_id      text PRIMARY KEY,
  at            timestamptz NOT NULL,
  by_user       text,
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
  prev_hash    text,                          -- reserved: Merkle track (M)
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
-- Mutated only by edge CRUD via commit(); the indexer never wipes/rebuilds
-- this table. Removal is lifecycle='retired', never DELETE.
CREATE TABLE IF NOT EXISTS edges (
  id              text PRIMARY KEY,           -- edge_<ulid>
  doco_id         text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  edge_type       text NOT NULL,
  from_id         text NOT NULL,
  from_node_type  text NOT NULL,
  to_id           text NOT NULL,
  to_node_type    text NOT NULL,
  props           jsonb,
  lifecycle       text NOT NULL DEFAULT 'asserted',
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

-- Full-text search. Five tables (one per top-level entity category) so the
-- search filter logic can pick the right shape directly. The indexer
-- populates summary + body; search_tsv is a generated tsvector with English
-- stemming and weighting (A=summary, B=body). A GIN index per table handles
-- `@@` queries efficiently. Cross-category search is a UNION over tables.

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

CREATE TABLE IF NOT EXISTS entity_fts_policies (
  entity_id       text PRIMARY KEY,
  doco_id         text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  policy_kind     text NOT NULL CHECK (policy_kind IN ('guidance', 'node_authoring')),
  -- Renamed from `summary` to `policy` by migration 038 to match the
  -- canonical policies tables. The FTS column tracks the source.
  policy          text,
  body            text,
  search_tsv      tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(policy, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'B')
  ) STORED
);
CREATE INDEX IF NOT EXISTS entity_fts_policies_doco_idx ON entity_fts_policies (doco_id);
CREATE INDEX IF NOT EXISTS entity_fts_policies_tsv_idx  ON entity_fts_policies USING gin (search_tsv);

CREATE TABLE IF NOT EXISTS entity_fts_users (
  entity_id   text PRIMARY KEY,
  summary     text,
  body        text,
  search_tsv  tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(summary, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'B')
  ) STORED
);
CREATE INDEX IF NOT EXISTS entity_fts_users_tsv_idx ON entity_fts_users USING gin (search_tsv);

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

CREATE TABLE IF NOT EXISTS doco_templates (
  id           text PRIMARY KEY,
  handle       text NOT NULL UNIQUE,
  owner_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        text NOT NULL,
  description  text NOT NULL,
  data         jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS doco_templates_owner_idx ON doco_templates (owner_id);
