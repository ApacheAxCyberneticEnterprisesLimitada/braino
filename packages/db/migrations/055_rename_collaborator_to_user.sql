-- 055_rename_collaborator_to_user.sql
-- ============================================================
-- Platform-wide vocabulary rename: "collaborator" -> "user",
-- including the primary-key prefix collaborator_<ULID> -> user_<ULID>.
--
-- Surface area:
--   * Tables: collaborators -> users,
--     entity_fts_collaborators -> entity_fts_users.
--   * 16 *collaborator*-named columns renamed to *user* (org_users,
--     doco_users, oauth_*, audit_events.by_collaborator, chat_*,
--     perspectives, doco_perspectives, agent_turn_metrics,
--     group_chat_*, doco_project_tokens).
--   * 18 foreign keys that referenced collaborators(id) re-pointed at
--     users(id) (incl. ideas.proposer_id,
--     feedback_reports.created_by/reviewed_by, doco_templates.owner_id).
--     NB: decisions.decided_by is NOT among them — its FK was dropped in
--     migration 025 because the column holds a principal_<ulid>.
--   * Every stored collaborator_<ULID> value rewritten to user_<ULID>:
--     the FK columns above, the by-convention provenance columns
--     created_by/updated_by on every neuron/policy/principal table,
--     audit_events.entity_type/entity_id, embeddings, synapses, and the
--     denormalized id/owner_id mirrors inside `data` jsonb.
--
-- Strategy mirrors 028 (primitive -> policy): schema.sql now creates the
-- post-rename objects (`users`, `entity_fts_users`) and the post-rename
-- column names. We cannot ALTER TABLE ... RENAME over an already-created
-- table, so this migration MOVES rows into the baseline-created tables,
-- rewrites ids/columns, re-points FKs, and drops the legacy tables. Works
-- for both startup paths:
--
--   1. Fresh DB: only the post-rename objects exist (schema baseline);
--      every `IF EXISTS collaborators` guard short-circuits. The
--      unguarded `CREATE INDEX IF NOT EXISTS` tail still (re)asserts the
--      renamed-column indexes that were removed from the baseline.
--
--   2. Existing prod DB: `users`/`entity_fts_users` exist empty (created
--      by today's baseline); `collaborators`/`entity_fts_collaborators`
--      carry the real rows; the reference tables still have their
--      *collaborator* columns + FKs to collaborators. Rows get moved +
--      rewritten, columns renamed, FKs re-pointed, legacy dropped.
--
-- Idempotent: every block re-checks state before mutating, so a partial
-- replay is safe.
-- ============================================================

-- ── 1. Move identity rows collaborators -> users ────────────────────────
-- owner_id is a self-FK; insert it NULL first, then backfill so parent
-- rows are guaranteed present regardless of insertion order.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'collaborators') THEN
    INSERT INTO users
      (id, kind, github_id, github_login, email, avatar_url, owner_id, data,
       created_at, updated_at, deactivated_at)
    SELECT
      REPLACE(id, 'collaborator_', 'user_'),
      kind, github_id, github_login, email, avatar_url,
      NULL,
      CASE
        WHEN data ? 'id' OR data ? 'owner_id'
        THEN REPLACE(data::text, 'collaborator_', 'user_')::jsonb
        ELSE data
      END,
      created_at, updated_at, deactivated_at
    FROM collaborators
    ON CONFLICT (id) DO NOTHING;

    UPDATE users u
       SET owner_id = REPLACE(c.owner_id, 'collaborator_', 'user_')
      FROM collaborators c
     WHERE u.id = REPLACE(c.id, 'collaborator_', 'user_')
       AND c.owner_id IS NOT NULL;
  END IF;
END $$;

-- ── 2. Rename the *collaborator* columns -> *user* ──────────────────────
-- Guarded RENAME (Postgres has no RENAME COLUMN IF EXISTS). The FK rides
-- along on the renamed column until step 3 drops collaborators CASCADE.
DO $$
DECLARE
  r text[];
  renames text[][] := ARRAY[
    ['org_users','collaborator_id','user_id'],
    ['doco_users','collaborator_id','user_id'],
    ['oauth_authorization_codes','collaborator_id','user_id'],
    ['oauth_access_tokens','collaborator_id','user_id'],
    ['oauth_refresh_tokens','collaborator_id','user_id'],
    ['oauth_device_authorizations','collaborator_id','user_id'],
    ['doco_project_tokens','created_by_collaborator_id','created_by_user_id'],
    ['audit_events','by_collaborator','by_user'],
    ['chat_conversations','collaborator_id','user_id'],
    ['chat_attachments','collaborator_id','user_id'],
    ['doco_perspectives','attached_by_collaborator','attached_by_user'],
    ['perspectives','owner_collaborator_id','owner_user_id'],
    ['agent_turn_metrics','collaborator_id','user_id'],
    ['group_chat_user_links','collaborator_id','user_id'],
    ['group_chat_installations','installed_by_collaborator_id','installed_by_user_id'],
    ['group_chat_channel_connections','created_by_collaborator_id','created_by_user_id']
  ];
BEGIN
  FOREACH r SLICE 1 IN ARRAY renames LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = r[1] AND column_name = r[2])
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = r[1] AND column_name = r[3]) THEN
      EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I', r[1], r[2], r[3]);
    END IF;
  END LOOP;
END $$;

-- ── 3. Drop the legacy collaborators table (drops its 20 FKs + indexes) ─
DROP TABLE IF EXISTS collaborators CASCADE;

-- ── 4. Rewrite stored collaborator_<ULID> values -> user_<ULID> ─────────
-- No FK references collaborators now, so these are unconstrained. Each
-- predicate is LIKE 'collaborator_%' so re-runs are no-ops.
DO $$
DECLARE
  t text;
  -- (table, column) pairs holding collaborator-shaped ids by convention.
  cols text[][] := ARRAY[
    -- renamed FK columns
    ['org_users','user_id'],['doco_users','user_id'],
    ['oauth_authorization_codes','user_id'],['oauth_access_tokens','user_id'],
    ['oauth_refresh_tokens','user_id'],['oauth_device_authorizations','user_id'],
    ['doco_project_tokens','created_by_user_id'],
    ['chat_conversations','user_id'],['chat_attachments','user_id'],
    ['doco_perspectives','attached_by_user'],['perspectives','owner_user_id'],
    ['agent_turn_metrics','user_id'],['group_chat_user_links','user_id'],
    ['group_chat_installations','installed_by_user_id'],
    ['group_chat_channel_connections','created_by_user_id'],
    -- name-stable FK columns
    ['decisions','decided_by'],['ideas','proposer_id'],
    ['feedback_reports','created_by'],['feedback_reports','reviewed_by'],
    ['doco_templates','owner_id'],
    -- audit
    ['audit_events','by_user'],['audit_events','entity_id'],
    ['embeddings','entity_id'],['synapses','from_id'],['synapses','to_id'],
    -- by-convention provenance (created_by/updated_by)
    ['intents','created_by'],['intents','updated_by'],
    ['decisions','created_by'],['decisions','updated_by'],
    ['rules','created_by'],['rules','updated_by'],
    ['actions','created_by'],['actions','updated_by'],
    ['logs','created_by'],['logs','updated_by'],
    ['evals','created_by'],['evals','updated_by'],
    ['ideas','created_by'],['ideas','updated_by'],
    ['states','created_by'],['states','updated_by'],
    ['guidance_policies','created_by'],['guidance_policies','updated_by'],
    ['neuron_authoring_policies','created_by'],['neuron_authoring_policies','updated_by'],
    ['reference_entities','created_by'],['reference_entities','updated_by'],
    ['principals','created_by'],['principals','updated_by']
  ];
  cr text[];
BEGIN
  FOREACH cr SLICE 1 IN ARRAY cols LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = cr[1] AND column_name = cr[2]) THEN
      EXECUTE format(
        'UPDATE %I SET %I = REPLACE(%I, ''collaborator_'', ''user_'') WHERE %I LIKE ''collaborator_%%''',
        cr[1], cr[2], cr[2], cr[2]);
    END IF;
  END LOOP;

  -- audit_events.entity_type discriminator for collaborator entities.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'audit_events' AND column_name = 'entity_type') THEN
    UPDATE audit_events SET entity_type = 'user' WHERE entity_type = 'collaborator';
  END IF;

  -- Denormalized id mirrors inside data jsonb (principals + neurons set
  -- created_by/updated_by/owner_id/proposer_id/decided_by in data).
  FOREACH t IN ARRAY ARRAY[
    'principals','intents','decisions','rules','actions','logs','evals',
    'ideas','states','guidance_policies','neuron_authoring_policies','reference_entities'
  ] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = t AND column_name = 'data') THEN
      EXECUTE format(
        'UPDATE %I SET data = REPLACE(data::text, ''collaborator_'', ''user_'')::jsonb
          WHERE data::text LIKE ''%%collaborator_%%''', t);
    END IF;
  END LOOP;
END $$;

-- ── 5. Re-point the 19 foreign keys at users(id) (self-FK already on the
--       baseline users table). ON DELETE rules preserved verbatim. ───────
DO $$
DECLARE
  fk text[];
  fks text[][] := ARRAY[
    ['org_users','user_id','org_users_user_id_fkey','CASCADE'],
    ['doco_users','user_id','doco_users_user_id_fkey','CASCADE'],
    ['oauth_authorization_codes','user_id','oauth_authorization_codes_user_id_fkey','CASCADE'],
    ['oauth_access_tokens','user_id','oauth_access_tokens_user_id_fkey','CASCADE'],
    ['oauth_refresh_tokens','user_id','oauth_refresh_tokens_user_id_fkey','CASCADE'],
    ['oauth_device_authorizations','user_id','oauth_device_authorizations_user_id_fkey','CASCADE'],
    ['doco_project_tokens','created_by_user_id','doco_project_tokens_created_by_user_id_fkey','CASCADE'],
    ['doco_templates','owner_id','doco_templates_owner_id_fkey','CASCADE'],
    -- NB: decisions.decided_by deliberately has NO FK. Migration 013 added
    -- decisions_decided_by_fk → collaborators(id); migration 025 dropped it
    -- because decided_by holds a principal_<ulid> (a Principal neuron), not
    -- an OAuth identity. Re-adding it here would 500 every Decision capture.
    ['ideas','proposer_id','ideas_proposer_fk','SET NULL'],
    ['feedback_reports','created_by','feedback_reports_created_by_fkey','SET NULL'],
    ['feedback_reports','reviewed_by','feedback_reports_reviewed_by_fkey','SET NULL'],
    ['chat_conversations','user_id','chat_conversations_user_id_fkey','CASCADE'],
    ['chat_attachments','user_id','chat_attachments_user_id_fkey','CASCADE'],
    ['doco_perspectives','attached_by_user','doco_perspectives_attached_by_user_fkey','SET NULL'],
    ['perspectives','owner_user_id','perspectives_owner_user_id_fkey','SET NULL'],
    ['group_chat_user_links','user_id','group_chat_user_links_user_id_fkey','CASCADE'],
    ['group_chat_installations','installed_by_user_id','group_chat_installations_installed_by_user_id_fkey','SET NULL'],
    ['group_chat_channel_connections','created_by_user_id','group_chat_channel_connections_created_by_user_id_fkey','SET NULL']
  ];
BEGIN
  FOREACH fk SLICE 1 IN ARRAY fks LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = fk[1] AND column_name = fk[2])
       AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = fk[3]) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES users(id) ON DELETE %s',
        fk[1], fk[3], fk[2], fk[4]);
    END IF;
  END LOOP;
END $$;

-- ── 6. Move FTS rows entity_fts_collaborators -> entity_fts_users ───────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'entity_fts_collaborators') THEN
    INSERT INTO entity_fts_users (entity_id, summary, body)
    SELECT REPLACE(entity_id, 'collaborator_', 'user_'), summary, body
      FROM entity_fts_collaborators
    ON CONFLICT (entity_id) DO NOTHING;
    DROP TABLE entity_fts_collaborators CASCADE;
  END IF;
END $$;

-- ── 7. Rename surviving indexes on the column-rename tables, and (re)assert
--       the renamed-column indexes removed from the baseline. ────────────
DO $$
DECLARE
  ix text[];
  idx_renames text[][] := ARRAY[
    ['org_users_collaborator_idx','org_users_user_idx'],
    ['doco_users_collaborator_idx','doco_users_user_idx'],
    ['oauth_access_tokens_collaborator_idx','oauth_access_tokens_user_idx'],
    ['oauth_refresh_tokens_collaborator_idx','oauth_refresh_tokens_user_idx'],
    ['audit_events_collaborator_idx','audit_events_user_idx'],
    ['group_chat_user_links_collaborator_idx','group_chat_user_links_user_idx'],
    ['idx_chat_conversations_collaborator_active','idx_chat_conversations_user_active']
  ];
BEGIN
  FOREACH ix SLICE 1 IN ARRAY idx_renames LOOP
    IF EXISTS (SELECT 1 FROM pg_class WHERE relkind = 'i' AND relname = ix[1])
       AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relkind = 'i' AND relname = ix[2]) THEN
      EXECUTE format('ALTER INDEX %I RENAME TO %I', ix[1], ix[2]);
    END IF;
  END LOOP;
END $$;

-- Renamed-column secondary indexes (removed from schema.sql baseline so the
-- baseline never references user_id on an existing prod table before this
-- migration renames it). Idempotent on both paths.
CREATE INDEX IF NOT EXISTS org_users_user_idx ON org_users (user_id, role);
CREATE INDEX IF NOT EXISTS doco_users_user_idx ON doco_users (user_id, role);
CREATE INDEX IF NOT EXISTS oauth_access_tokens_user_idx ON oauth_access_tokens (user_id, revoked);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_user_idx ON oauth_refresh_tokens (user_id, revoked);
CREATE INDEX IF NOT EXISTS audit_events_user_idx ON audit_events (by_user, at DESC);
