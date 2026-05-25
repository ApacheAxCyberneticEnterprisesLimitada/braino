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
--   - `synapses` materializes relationships between neurons for graph queries.
--   - `audit_events` is the structured history (decision_01KRKESCBTYG4005VMPKYNYR53).
--   - New schema changes belong in packages/db/migrations/.
--
-- Vocabulary (post-migration-005):
--   neurons   — graph entities (10 types: intent/idea/rule/decision/action/
--               log/eval/reference/state/principal)
--   policies — Doco-level authoring metadata (2 kinds: guidance / neuron_authoring)
--   synapses   — relationships between neurons
--   collaborators — OAuth identities (person/agent), separate from principals
--                   (which are role-personas referenced by actor_id/actors[]).

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
  data            jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deactivated_at  timestamptz
);
CREATE INDEX IF NOT EXISTS collaborators_github_login_idx ON collaborators (github_login);
CREATE INDEX IF NOT EXISTS collaborators_kind_idx          ON collaborators (kind);

CREATE TABLE IF NOT EXISTS principals (
  id              text PRIMARY KEY,            -- principal_<ulid>
  -- Principals are Doco-scoped (migration 020). The FK + NOT NULL +
  -- UNIQUE(doco_id, name) are added by 020 after the docos table
  -- exists; declared nullable here only so the schema baseline parses
  -- before docos is created later in this file.
  doco_id         text,
  name            text NOT NULL,                -- role label (e.g. "system",
                                                -- "customer-service-rep")
  summary         text,
  lifecycle       text,
  body_md         text,
  -- Reserved role-principal flag (set for user/human/doco-host/github).
  -- Promoted out of `data` jsonb by migration 035.
  role_principal  boolean NOT NULL DEFAULT false,
  data            jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text,                        -- collaborator_<ulid>
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
  collaborator_id  text NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner', 'approver', 'author', 'reader')),
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, collaborator_id)
);
CREATE INDEX IF NOT EXISTS org_users_collaborator_idx ON org_users (collaborator_id, role);

-- Every Doco has a single human-readable `handle`. It lives in the
-- same flat namespace as top-level host routes. The internal ULID `id`
-- stays as the FK target for entity tables; `handle` is what URLs and
-- public API calls use.
CREATE TABLE IF NOT EXISTS docos (
  id              text PRIMARY KEY,
  handle          text NOT NULL UNIQUE,
  owner_id        text NOT NULL,    -- organization_<ulid>
  org_id          text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text,
  visibility      text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  allowed_neuron_types text[],
  default_neuron_lifecycle text,
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
CREATE INDEX IF NOT EXISTS rules_kind_idx     ON rules (doco_id, kind);
CREATE INDEX IF NOT EXISTS rules_severity_idx ON rules (doco_id, severity);

CREATE TABLE IF NOT EXISTS guidance_policies (
  id          text PRIMARY KEY,
  doco_id     text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  summary     text,
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

CREATE TABLE IF NOT EXISTS neuron_authoring_policies (
  id          text PRIMARY KEY,
  doco_id     text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  summary     text,
  lifecycle   text,
  body_md     text,
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
CREATE INDEX IF NOT EXISTS neuron_authoring_policies_doco_idx
  ON neuron_authoring_policies (doco_id, created_at DESC);
CREATE INDEX IF NOT EXISTS neuron_authoring_policies_lifecycle_idx
  ON neuron_authoring_policies (doco_id, lifecycle);

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
CREATE INDEX IF NOT EXISTS actions_verb_idx         ON actions (doco_id, verb);
CREATE INDEX IF NOT EXISTS actions_performed_at_idx ON actions (doco_id, performed_at DESC);

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
CREATE INDEX IF NOT EXISTS logs_verb_idx        ON logs (doco_id, verb);
CREATE INDEX IF NOT EXISTS logs_happened_at_idx ON logs (doco_id, happened_at DESC);

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
CREATE INDEX IF NOT EXISTS evals_kind_idx ON evals (doco_id, kind);

-- State is a neuron in a
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
CREATE INDEX IF NOT EXISTS states_kind_idx ON states (doco_id, kind);

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
CREATE INDEX IF NOT EXISTS reference_entities_ref_type_idx
  ON reference_entities (doco_id, ref_type);

-- Audit events: one row per mutation.

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

-- Org-scope audit events. For those rows, `org_id` is set and `doco_id`
-- is NULL.
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
-- by the indexer. Doco-scoped via doco_id; both endpoints can be any
-- neuron_type so we can't FK them.
CREATE TABLE IF NOT EXISTS synapses (
  from_id         text NOT NULL,
  from_neuron_type  text NOT NULL,
  to_id           text NOT NULL,
  to_neuron_type    text NOT NULL,
  synapse_type       text NOT NULL,
  doco_id         text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  synapse_props_json jsonb,
  PRIMARY KEY (from_id, to_id, synapse_type)
);
CREATE INDEX IF NOT EXISTS synapses_doco_idx        ON synapses (doco_id);
CREATE INDEX IF NOT EXISTS synapses_to_idx          ON synapses (to_id, synapse_type);
CREATE INDEX IF NOT EXISTS synapses_from_type_idx   ON synapses (from_id, synapse_type);
CREATE INDEX IF NOT EXISTS synapses_type_idx        ON synapses (synapse_type);
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

CREATE TABLE IF NOT EXISTS entity_fts_policies (
  entity_id       text PRIMARY KEY,
  doco_id         text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  policy_kind     text NOT NULL CHECK (policy_kind IN ('guidance', 'neuron_authoring')),
  summary         text,
  body            text,
  search_tsv      tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(summary, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'B')
  ) STORED
);
CREATE INDEX IF NOT EXISTS entity_fts_policies_doco_idx ON entity_fts_policies (doco_id);
CREATE INDEX IF NOT EXISTS entity_fts_policies_tsv_idx  ON entity_fts_policies USING gin (search_tsv);

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

-- ──────────────────────────────────────────────────────────────────────────
-- Multi-level access (decision_01KS0JBJ5X0AZ4XJJFKEWE1R62).
--
-- Four roles (owner / approver / author / reader) granted at two levels
-- (org / doco). Effective role = max across levels (highest-wins
-- additive composition). Author-role writes default to lifecycle
-- `proposed`; only approver+ can transition.

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

-- Committable read-only "project tokens" for Docos. Distinct from
-- oauth_access_tokens: tied to the Doco (not a collaborator), fixed
-- reader scope on one Doco, no expiry — designed to live in the
-- repo at .doco/project-tokens.json so agents that clone the repo
-- can read the Doco without OAuth. Suitable only when repo-readers
-- = acceptable Doco-readers; the owner mints with explicit
-- confirmation.
CREATE TABLE IF NOT EXISTS doco_project_tokens (
  token                       text PRIMARY KEY,
  doco_id                     text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  created_by_collaborator_id  text NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
  label                       text,
  revoked                     boolean NOT NULL DEFAULT false,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  last_used_at                timestamptz
);
CREATE INDEX IF NOT EXISTS doco_project_tokens_doco_idx
  ON doco_project_tokens (doco_id) WHERE NOT revoked;

CREATE TABLE IF NOT EXISTS doco_templates (
  id           text PRIMARY KEY,
  handle       text NOT NULL UNIQUE,
  owner_id     text NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
  label        text NOT NULL,
  description  text NOT NULL,
  data         jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS doco_templates_owner_idx ON doco_templates (owner_id);
