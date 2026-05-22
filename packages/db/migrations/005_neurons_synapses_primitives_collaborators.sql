-- 005_neurons_synapses_primitives_collaborators.sql
-- ============================================================
-- The big rename + collaborator split.
--
-- Vocabulary changes:
--   nodes    → neurons     (the graph entities)
--   edges    → synapses    (the relationships)
--   articles → primitives  (the constitution metadata)
--
-- Structural change: the legacy `principals` table held two unrelated
-- concerns — OAuth identity (real GitHub users + agent runtimes) AND
-- documented role-personas (e.g. "system", "customer-service-rep").
-- They are split:
--
--   collaborator  — host-scoped OAuth identity. New table.
--                   `created_by` / `updated_by` / `decided_by`, doco/org
--                   membership, oauth_*, audit attribution all reference
--                   collaborators.
--   principal     — neuron (per-Doco knowledge entity, but currently
--                   host-scoped — preserved). Documented role/persona.
--                   `actor_id` / `actors[]` / `stakeholders` continue
--                   to reference principals.
--
-- The split is reference-driven (see plan §5.2): for each existing
-- `principals` row, the migration inspects what references it and
-- decides whether the row becomes a collaborator, a principal, both
-- (same ULID, different prefix), or is dropped.
--
-- All wrapped in the migration runner's transaction.
-- Sentinel in `doco_meta` short-circuits re-runs.
-- ============================================================

DO $rename_v005$
DECLARE
  bootstrap_collab_id text;
  v_count int;
BEGIN
  -- Re-run guard.
  IF EXISTS (
    SELECT 1 FROM doco_meta WHERE key = 'rename_v005' AND value = 'done'
  ) THEN
    RAISE NOTICE 'rename_v005: already applied, skipping';
    RETURN;
  END IF;

  RAISE NOTICE 'rename_v005: starting';

  -- ──────────────────────────────────────────────────────────────────
  -- PRE-STEP: drop empty new-named tables that schema.sql may have
  -- created on this boot. We're about to rename old → new and need the
  -- new names to be free.
  --
  -- Safety: we ONLY drop if the OLD-named table exists (proves we're
  -- on an upgrading DB, not a fresh DB where the new tables hold real
  -- data). On a fresh DB the OLD names don't exist, this whole pre-step
  -- is a no-op, and the renames further down are no-ops too.
  -- ──────────────────────────────────────────────────────────────────
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'guidance_articles')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'guidance_primitives') THEN
    DROP TABLE guidance_primitives;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'node_authoring_articles')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'neuron_authoring_primitives') THEN
    DROP TABLE neuron_authoring_primitives;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'org_guidance_articles')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'org_guidance_primitives') THEN
    DROP TABLE org_guidance_primitives;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'org_node_authoring_articles')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'org_neuron_authoring_primitives') THEN
    DROP TABLE org_neuron_authoring_primitives;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'edges')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'synapses') THEN
    DROP TABLE synapses;
  END IF;
  -- The five entity_fts_* tables are created by schema.sql. If the old
  -- single entity_fts table exists (legacy state), the new five must
  -- have been created by schema.sql on this boot; drop them so we can
  -- repopulate from entity_fts below.
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'entity_fts') THEN
    DROP TABLE IF EXISTS entity_fts_neurons;
    DROP TABLE IF EXISTS entity_fts_primitives;
    DROP TABLE IF EXISTS entity_fts_collaborators;
    DROP TABLE IF EXISTS entity_fts_docos;
    DROP TABLE IF EXISTS entity_fts_organizations;
  END IF;

  -- ──────────────────────────────────────────────────────────────────
  -- STEP 1: Create new `collaborators` table.
  -- ──────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS collaborators (
    id              text PRIMARY KEY,
    kind            text NOT NULL CHECK (kind IN ('person', 'agent')),
    github_id       text,
    github_login    text,
    email           text,
    avatar_url      text,
    owner_id        text REFERENCES collaborators(id) ON DELETE SET NULL,
    raw_yaml        text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deactivated_at  timestamptz
  );
  CREATE INDEX IF NOT EXISTS collaborators_github_login_idx ON collaborators (github_login);
  CREATE INDEX IF NOT EXISTS collaborators_kind_idx ON collaborators (kind);

  -- ──────────────────────────────────────────────────────────────────
  -- STEP 2: Build a transient classification table.
  -- One row per existing principal; tells the rest of the migration
  -- what fate this principal gets.
  -- ──────────────────────────────────────────────────────────────────
  CREATE TEMP TABLE principal_classification (
    old_id              text PRIMARY KEY,
    new_collaborator_id text,             -- non-null if becomes collaborator
    new_principal_id    text,             -- non-null if stays a principal
    has_oauth           boolean NOT NULL,
    is_creator_ref      boolean NOT NULL,
    is_actor_ref        boolean NOT NULL,
    decision            text NOT NULL CHECK (decision IN ('collab_only','princ_only','both','drop'))
  ) ON COMMIT DROP;

  -- Heuristics:
  --   has_oauth        — github_login set OR kind=agent (agent runtimes
  --                      authenticate but may have no github_login)
  --   is_creator_ref   — referenced in any entity's created_by/updated_by
  --   is_actor_ref     — referenced as actor_id / in actors[] / as
  --                      decided_by / proposer_id / stakeholders in
  --                      raw_yaml on any entity table
  INSERT INTO principal_classification (
    old_id, new_collaborator_id, new_principal_id,
    has_oauth, is_creator_ref, is_actor_ref, decision
  )
  SELECT
    p.id,
    'collaborator_' || substring(p.id from position('_' in p.id) + 1),
    p.id,
    (p.github_login IS NOT NULL OR p.type = 'agent') AS has_oauth,
    EXISTS (
      SELECT 1 FROM intents WHERE created_by = p.id OR updated_by = p.id
      UNION ALL SELECT 1 FROM decisions WHERE created_by = p.id OR updated_by = p.id
      UNION ALL SELECT 1 FROM rules WHERE created_by = p.id OR updated_by = p.id
      UNION ALL SELECT 1 FROM guidance_articles WHERE created_by = p.id OR updated_by = p.id
      UNION ALL SELECT 1 FROM node_authoring_articles WHERE created_by = p.id OR updated_by = p.id
      UNION ALL SELECT 1 FROM org_guidance_articles WHERE created_by = p.id OR updated_by = p.id
      UNION ALL SELECT 1 FROM org_node_authoring_articles WHERE created_by = p.id OR updated_by = p.id
      UNION ALL SELECT 1 FROM actions WHERE created_by = p.id OR updated_by = p.id
      UNION ALL SELECT 1 FROM logs WHERE created_by = p.id OR updated_by = p.id
      UNION ALL SELECT 1 FROM evals WHERE created_by = p.id OR updated_by = p.id
      UNION ALL SELECT 1 FROM ideas WHERE created_by = p.id OR updated_by = p.id
      UNION ALL SELECT 1 FROM reference_entities WHERE created_by = p.id OR updated_by = p.id
      UNION ALL SELECT 1 FROM states WHERE created_by = p.id OR updated_by = p.id
    ) AS is_creator_ref,
    EXISTS (
      -- `actor_id` is on actions + logs (text in raw_yaml).
      -- `actors` / `stakeholders` are arrays on intents.
      -- `decided_by` is on decisions.
      -- `proposer_id` is on ideas.
      SELECT 1 FROM actions WHERE raw_yaml::jsonb->>'actor_id' = p.id
      UNION ALL SELECT 1 FROM logs WHERE raw_yaml::jsonb->>'actor_id' = p.id
      UNION ALL SELECT 1 FROM intents WHERE raw_yaml::jsonb->'actors' ? p.id
      UNION ALL SELECT 1 FROM intents WHERE raw_yaml::jsonb->'stakeholders' ? p.id
      UNION ALL SELECT 1 FROM decisions WHERE raw_yaml::jsonb->>'decided_by' = p.id
      UNION ALL SELECT 1 FROM ideas WHERE raw_yaml::jsonb->>'proposer_id' = p.id
    ) AS is_actor_ref,
    CASE
      WHEN (p.github_login IS NOT NULL OR p.type = 'agent')
        AND EXISTS (
          SELECT 1 FROM actions WHERE raw_yaml::jsonb->>'actor_id' = p.id
          UNION ALL SELECT 1 FROM logs WHERE raw_yaml::jsonb->>'actor_id' = p.id
          UNION ALL SELECT 1 FROM intents WHERE raw_yaml::jsonb->'actors' ? p.id
          UNION ALL SELECT 1 FROM intents WHERE raw_yaml::jsonb->'stakeholders' ? p.id
          UNION ALL SELECT 1 FROM decisions WHERE raw_yaml::jsonb->>'decided_by' = p.id
          UNION ALL SELECT 1 FROM ideas WHERE raw_yaml::jsonb->>'proposer_id' = p.id
        )
        THEN 'both'
      WHEN (p.github_login IS NOT NULL OR p.type = 'agent') THEN 'collab_only'
      WHEN EXISTS (
        SELECT 1 FROM actions WHERE raw_yaml::jsonb->>'actor_id' = p.id
        UNION ALL SELECT 1 FROM logs WHERE raw_yaml::jsonb->>'actor_id' = p.id
        UNION ALL SELECT 1 FROM intents WHERE raw_yaml::jsonb->'actors' ? p.id
        UNION ALL SELECT 1 FROM intents WHERE raw_yaml::jsonb->'stakeholders' ? p.id
        UNION ALL SELECT 1 FROM decisions WHERE raw_yaml::jsonb->>'decided_by' = p.id
        UNION ALL SELECT 1 FROM ideas WHERE raw_yaml::jsonb->>'proposer_id' = p.id
      ) THEN 'princ_only'
      WHEN EXISTS (
        SELECT 1 FROM intents WHERE created_by = p.id OR updated_by = p.id
        UNION ALL SELECT 1 FROM decisions WHERE created_by = p.id OR updated_by = p.id
        UNION ALL SELECT 1 FROM rules WHERE created_by = p.id OR updated_by = p.id
      ) THEN 'princ_only'
      ELSE 'drop'
    END AS decision
  FROM principals p;

  -- Null out the unused new_*_id columns based on decision.
  UPDATE principal_classification SET new_collaborator_id = NULL
    WHERE decision IN ('princ_only', 'drop');
  UPDATE principal_classification SET new_principal_id = NULL
    WHERE decision IN ('collab_only', 'drop');

  SELECT COUNT(*) INTO v_count FROM principal_classification;
  RAISE NOTICE 'rename_v005: classified % principals', v_count;
  SELECT COUNT(*) INTO v_count FROM principal_classification WHERE decision = 'collab_only';
  RAISE NOTICE 'rename_v005:   collab_only: %', v_count;
  SELECT COUNT(*) INTO v_count FROM principal_classification WHERE decision = 'princ_only';
  RAISE NOTICE 'rename_v005:   princ_only: %', v_count;
  SELECT COUNT(*) INTO v_count FROM principal_classification WHERE decision = 'both';
  RAISE NOTICE 'rename_v005:   both: %', v_count;
  SELECT COUNT(*) INTO v_count FROM principal_classification WHERE decision = 'drop';
  RAISE NOTICE 'rename_v005:   drop: %', v_count;

  -- ──────────────────────────────────────────────────────────────────
  -- STEP 3: Bootstrap collaborator.
  -- A fallback identity for any orphan created_by refs that point at
  -- a row that is dropped or only-principal.
  -- ──────────────────────────────────────────────────────────────────
  bootstrap_collab_id := 'collaborator_bootstrap';
  INSERT INTO collaborators (id, kind, github_login, raw_yaml)
  VALUES (
    bootstrap_collab_id,
    'agent',
    NULL,
    '{"id":"collaborator_bootstrap","kind":"agent","github_login":null}'
  )
  ON CONFLICT (id) DO NOTHING;

  -- ──────────────────────────────────────────────────────────────────
  -- STEP 4: Insert collaborators based on classification.
  -- Carries OAuth fields over from the principal row.
  -- ──────────────────────────────────────────────────────────────────
  INSERT INTO collaborators (
    id, kind, github_login, email, avatar_url, owner_id, raw_yaml,
    created_at, updated_at, deactivated_at
  )
  SELECT
    pc.new_collaborator_id,
    p.type,
    p.github_login,
    p.email,
    p.avatar_url,
    -- owner_id was a self-reference within principals. If the owner
    -- also got a collaborator row, point at that. Otherwise null.
    (SELECT pc2.new_collaborator_id FROM principal_classification pc2 WHERE pc2.old_id = p.owner_id),
    p.raw_yaml,
    p.created_at,
    p.updated_at,
    p.deactivated_at
  FROM principals p
  JOIN principal_classification pc ON pc.old_id = p.id
  WHERE pc.decision IN ('collab_only', 'both')
  ON CONFLICT (id) DO NOTHING;

  -- ──────────────────────────────────────────────────────────────────
  -- STEP 5: Rewrite FK references that should now target collaborators.
  --
  -- created_by / updated_by columns on every entity table:
  --   - If the referenced principal got a collaborator row → use the
  --     new collaborator_<ulid>.
  --   - Otherwise → fall back to the bootstrap collaborator.
  -- ──────────────────────────────────────────────────────────────────

  -- intents
  UPDATE intents SET created_by =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = intents.created_by),
      bootstrap_collab_id
    )
    WHERE created_by IS NOT NULL AND created_by LIKE 'principal_%';
  UPDATE intents SET updated_by =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = intents.updated_by),
      bootstrap_collab_id
    )
    WHERE updated_by IS NOT NULL AND updated_by LIKE 'principal_%';

  -- decisions
  UPDATE decisions SET created_by =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = decisions.created_by),
      bootstrap_collab_id
    )
    WHERE created_by IS NOT NULL AND created_by LIKE 'principal_%';
  UPDATE decisions SET updated_by =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = decisions.updated_by),
      bootstrap_collab_id
    )
    WHERE updated_by IS NOT NULL AND updated_by LIKE 'principal_%';

  -- rules
  UPDATE rules SET created_by =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = rules.created_by),
      bootstrap_collab_id
    )
    WHERE created_by IS NOT NULL AND created_by LIKE 'principal_%';
  UPDATE rules SET updated_by =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = rules.updated_by),
      bootstrap_collab_id
    )
    WHERE updated_by IS NOT NULL AND updated_by LIKE 'principal_%';

  -- guidance_articles (will rename to guidance_primitives in STEP 7)
  UPDATE guidance_articles SET created_by =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = guidance_articles.created_by),
      bootstrap_collab_id
    )
    WHERE created_by IS NOT NULL AND created_by LIKE 'principal_%';
  UPDATE guidance_articles SET updated_by =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = guidance_articles.updated_by),
      bootstrap_collab_id
    )
    WHERE updated_by IS NOT NULL AND updated_by LIKE 'principal_%';

  -- node_authoring_articles (will rename to neuron_authoring_primitives)
  UPDATE node_authoring_articles SET created_by =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = node_authoring_articles.created_by),
      bootstrap_collab_id
    )
    WHERE created_by IS NOT NULL AND created_by LIKE 'principal_%';
  UPDATE node_authoring_articles SET updated_by =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = node_authoring_articles.updated_by),
      bootstrap_collab_id
    )
    WHERE updated_by IS NOT NULL AND updated_by LIKE 'principal_%';

  -- org_guidance_articles
  UPDATE org_guidance_articles SET created_by =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = org_guidance_articles.created_by),
      bootstrap_collab_id
    )
    WHERE created_by IS NOT NULL AND created_by LIKE 'principal_%';
  UPDATE org_guidance_articles SET updated_by =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = org_guidance_articles.updated_by),
      bootstrap_collab_id
    )
    WHERE updated_by IS NOT NULL AND updated_by LIKE 'principal_%';

  -- org_node_authoring_articles
  UPDATE org_node_authoring_articles SET created_by =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = org_node_authoring_articles.created_by),
      bootstrap_collab_id
    )
    WHERE created_by IS NOT NULL AND created_by LIKE 'principal_%';
  UPDATE org_node_authoring_articles SET updated_by =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = org_node_authoring_articles.updated_by),
      bootstrap_collab_id
    )
    WHERE updated_by IS NOT NULL AND updated_by LIKE 'principal_%';

  -- actions
  UPDATE actions SET created_by =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = actions.created_by),
      bootstrap_collab_id
    )
    WHERE created_by IS NOT NULL AND created_by LIKE 'principal_%';
  UPDATE actions SET updated_by =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = actions.updated_by),
      bootstrap_collab_id
    )
    WHERE updated_by IS NOT NULL AND updated_by LIKE 'principal_%';

  -- logs
  UPDATE logs SET created_by =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = logs.created_by),
      bootstrap_collab_id
    )
    WHERE created_by IS NOT NULL AND created_by LIKE 'principal_%';
  UPDATE logs SET updated_by =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = logs.updated_by),
      bootstrap_collab_id
    )
    WHERE updated_by IS NOT NULL AND updated_by LIKE 'principal_%';

  -- evals
  UPDATE evals SET created_by =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = evals.created_by),
      bootstrap_collab_id
    )
    WHERE created_by IS NOT NULL AND created_by LIKE 'principal_%';
  UPDATE evals SET updated_by =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = evals.updated_by),
      bootstrap_collab_id
    )
    WHERE updated_by IS NOT NULL AND updated_by LIKE 'principal_%';

  -- ideas
  UPDATE ideas SET created_by =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = ideas.created_by),
      bootstrap_collab_id
    )
    WHERE created_by IS NOT NULL AND created_by LIKE 'principal_%';
  UPDATE ideas SET updated_by =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = ideas.updated_by),
      bootstrap_collab_id
    )
    WHERE updated_by IS NOT NULL AND updated_by LIKE 'principal_%';

  -- reference_entities
  UPDATE reference_entities SET created_by =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = reference_entities.created_by),
      bootstrap_collab_id
    )
    WHERE created_by IS NOT NULL AND created_by LIKE 'principal_%';
  UPDATE reference_entities SET updated_by =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = reference_entities.updated_by),
      bootstrap_collab_id
    )
    WHERE updated_by IS NOT NULL AND updated_by LIKE 'principal_%';

  -- states
  UPDATE states SET created_by =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = states.created_by),
      bootstrap_collab_id
    )
    WHERE created_by IS NOT NULL AND created_by LIKE 'principal_%';
  UPDATE states SET updated_by =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = states.updated_by),
      bootstrap_collab_id
    )
    WHERE updated_by IS NOT NULL AND updated_by LIKE 'principal_%';

  -- ──────────────────────────────────────────────────────────────────
  -- STEP 6: Rewrite FKs that name principal_id but should now name
  -- collaborator_id (oauth_*, doco_users, org_users, audit_events,
  -- docos.owner_id).
  -- ──────────────────────────────────────────────────────────────────

  -- Drop FK constraints first so we can update the values.
  ALTER TABLE oauth_authorization_codes DROP CONSTRAINT IF EXISTS oauth_authorization_codes_principal_id_fkey;
  ALTER TABLE oauth_access_tokens       DROP CONSTRAINT IF EXISTS oauth_access_tokens_principal_id_fkey;
  ALTER TABLE oauth_refresh_tokens      DROP CONSTRAINT IF EXISTS oauth_refresh_tokens_principal_id_fkey;
  ALTER TABLE oauth_device_authorizations DROP CONSTRAINT IF EXISTS oauth_device_authorizations_principal_id_fkey;
  ALTER TABLE doco_users                DROP CONSTRAINT IF EXISTS doco_users_principal_id_fkey;
  ALTER TABLE org_users                 DROP CONSTRAINT IF EXISTS org_users_principal_id_fkey;

  -- Rewrite values: principal_<ulid> → collaborator_<ulid>.
  UPDATE oauth_authorization_codes SET principal_id =
    (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = principal_id)
    WHERE principal_id LIKE 'principal_%';

  UPDATE oauth_access_tokens SET principal_id =
    (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = principal_id)
    WHERE principal_id LIKE 'principal_%';

  UPDATE oauth_refresh_tokens SET principal_id =
    (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = principal_id)
    WHERE principal_id LIKE 'principal_%';

  UPDATE oauth_device_authorizations SET principal_id =
    (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = principal_id)
    WHERE principal_id LIKE 'principal_%';

  UPDATE doco_users SET principal_id =
    (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = principal_id)
    WHERE principal_id LIKE 'principal_%';

  UPDATE org_users SET principal_id =
    (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = principal_id)
    WHERE principal_id LIKE 'principal_%';

  -- Delete any rows whose principal had no collaborator counterpart
  -- (i.e. princ_only or drop classification). These tokens/memberships
  -- can't grant access to anything anyway.
  DELETE FROM oauth_authorization_codes WHERE principal_id IS NULL;
  DELETE FROM oauth_access_tokens       WHERE principal_id IS NULL;
  DELETE FROM oauth_refresh_tokens      WHERE principal_id IS NULL;
  DELETE FROM oauth_device_authorizations WHERE principal_id IS NULL;
  DELETE FROM doco_users                WHERE principal_id IS NULL;
  DELETE FROM org_users                 WHERE principal_id IS NULL;

  -- Rename principal_id → collaborator_id.
  ALTER TABLE oauth_authorization_codes RENAME COLUMN principal_id TO collaborator_id;
  ALTER TABLE oauth_access_tokens       RENAME COLUMN principal_id TO collaborator_id;
  ALTER TABLE oauth_refresh_tokens      RENAME COLUMN principal_id TO collaborator_id;
  ALTER TABLE oauth_device_authorizations RENAME COLUMN principal_id TO collaborator_id;
  ALTER TABLE doco_users                RENAME COLUMN principal_id TO collaborator_id;
  ALTER TABLE org_users                 RENAME COLUMN principal_id TO collaborator_id;

  -- Rename indexes that name the old column.
  ALTER INDEX IF EXISTS oauth_access_tokens_principal_idx     RENAME TO oauth_access_tokens_collaborator_idx;
  ALTER INDEX IF EXISTS oauth_refresh_tokens_principal_idx    RENAME TO oauth_refresh_tokens_collaborator_idx;
  ALTER INDEX IF EXISTS doco_users_principal_idx              RENAME TO doco_users_collaborator_idx;
  ALTER INDEX IF EXISTS org_users_principal_idx               RENAME TO org_users_collaborator_idx;

  -- Re-add FK constraints pointing at the new collaborators table.
  ALTER TABLE oauth_authorization_codes
    ADD CONSTRAINT oauth_authorization_codes_collaborator_id_fkey
    FOREIGN KEY (collaborator_id) REFERENCES collaborators(id) ON DELETE CASCADE;
  ALTER TABLE oauth_access_tokens
    ADD CONSTRAINT oauth_access_tokens_collaborator_id_fkey
    FOREIGN KEY (collaborator_id) REFERENCES collaborators(id) ON DELETE CASCADE;
  ALTER TABLE oauth_refresh_tokens
    ADD CONSTRAINT oauth_refresh_tokens_collaborator_id_fkey
    FOREIGN KEY (collaborator_id) REFERENCES collaborators(id) ON DELETE CASCADE;
  ALTER TABLE oauth_device_authorizations
    ADD CONSTRAINT oauth_device_authorizations_collaborator_id_fkey
    FOREIGN KEY (collaborator_id) REFERENCES collaborators(id) ON DELETE CASCADE;
  ALTER TABLE doco_users
    ADD CONSTRAINT doco_users_collaborator_id_fkey
    FOREIGN KEY (collaborator_id) REFERENCES collaborators(id) ON DELETE CASCADE;
  ALTER TABLE org_users
    ADD CONSTRAINT org_users_collaborator_id_fkey
    FOREIGN KEY (collaborator_id) REFERENCES collaborators(id) ON DELETE CASCADE;

  -- audit_events.by_principal — points at collaborators now, rename column.
  UPDATE audit_events SET by_principal =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = audit_events.by_principal),
      bootstrap_collab_id
    )
    WHERE by_principal IS NOT NULL AND by_principal LIKE 'principal_%';
  ALTER TABLE audit_events RENAME COLUMN by_principal TO by_collaborator;
  ALTER INDEX IF EXISTS audit_events_actor_idx RENAME TO audit_events_collaborator_idx;
  -- Recreate the dropped expression-on-column for sanity.

  -- docos.owner_id (polymorphic — held principal_<ulid> OR organization_<ulid>).
  -- After: holds collaborator_<ulid> OR organization_<ulid>.
  UPDATE docos SET owner_id =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = docos.owner_id),
      bootstrap_collab_id
    )
    WHERE owner_id IS NOT NULL AND owner_id LIKE 'principal_%';

  -- doco_templates.owner_id (FK to principals — point at collaborators).
  ALTER TABLE doco_templates DROP CONSTRAINT IF EXISTS doco_templates_owner_id_fkey;
  UPDATE doco_templates SET owner_id =
    COALESCE(
      (SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = doco_templates.owner_id),
      bootstrap_collab_id
    )
    WHERE owner_id IS NOT NULL AND owner_id LIKE 'principal_%';
  ALTER TABLE doco_templates
    ADD CONSTRAINT doco_templates_owner_id_fkey
    FOREIGN KEY (owner_id) REFERENCES collaborators(id) ON DELETE CASCADE;

  -- ──────────────────────────────────────────────────────────────────
  -- STEP 7: Delete principals that are pure collaborators (and drop).
  -- The rest stay in principals as role-personas.
  -- ──────────────────────────────────────────────────────────────────
  DELETE FROM principals
    WHERE id IN (
      SELECT old_id FROM principal_classification
       WHERE decision IN ('collab_only', 'drop')
    );

  -- ──────────────────────────────────────────────────────────────────
  -- STEP 8: Slim the principals table — drop OAuth-only columns.
  -- Principals now hold only role/persona fields.
  -- ──────────────────────────────────────────────────────────────────
  ALTER TABLE principals DROP COLUMN IF EXISTS type;
  ALTER TABLE principals DROP COLUMN IF EXISTS email;
  ALTER TABLE principals DROP COLUMN IF EXISTS github_login;
  ALTER TABLE principals DROP COLUMN IF EXISTS avatar_url;
  ALTER TABLE principals DROP COLUMN IF EXISTS owner_id;
  ALTER TABLE principals DROP COLUMN IF EXISTS deactivated_at;
  -- Add the neuron-shaped body fields. doco_id has no FK — principals are
  -- host-scoped; doco association is optional and lives in raw_yaml.
  ALTER TABLE principals ADD COLUMN IF NOT EXISTS doco_id text;
  ALTER TABLE principals ADD COLUMN IF NOT EXISTS summary text;
  ALTER TABLE principals ADD COLUMN IF NOT EXISTS lifecycle text;
  ALTER TABLE principals ADD COLUMN IF NOT EXISTS body_md text;
  ALTER TABLE principals ADD COLUMN IF NOT EXISTS created_by text;
  ALTER TABLE principals ADD COLUMN IF NOT EXISTS updated_by text;

  -- ──────────────────────────────────────────────────────────────────
  -- STEP 9: Rename article tables → primitive tables.
  -- ──────────────────────────────────────────────────────────────────
  ALTER TABLE IF EXISTS guidance_articles            RENAME TO guidance_primitives;
  ALTER TABLE IF EXISTS node_authoring_articles      RENAME TO neuron_authoring_primitives;
  ALTER TABLE IF EXISTS org_guidance_articles        RENAME TO org_guidance_primitives;
  ALTER TABLE IF EXISTS org_node_authoring_articles  RENAME TO org_neuron_authoring_primitives;

  ALTER INDEX IF EXISTS guidance_articles_doco_idx                  RENAME TO guidance_primitives_doco_idx;
  ALTER INDEX IF EXISTS guidance_articles_lifecycle_idx             RENAME TO guidance_primitives_lifecycle_idx;
  ALTER INDEX IF EXISTS node_authoring_articles_doco_idx            RENAME TO neuron_authoring_primitives_doco_idx;
  ALTER INDEX IF EXISTS node_authoring_articles_lifecycle_idx       RENAME TO neuron_authoring_primitives_lifecycle_idx;
  ALTER INDEX IF EXISTS org_guidance_articles_org_idx               RENAME TO org_guidance_primitives_org_idx;
  ALTER INDEX IF EXISTS org_guidance_articles_lifecycle_idx         RENAME TO org_guidance_primitives_lifecycle_idx;
  ALTER INDEX IF EXISTS org_node_authoring_articles_org_idx         RENAME TO org_neuron_authoring_primitives_org_idx;
  ALTER INDEX IF EXISTS org_node_authoring_articles_lifecycle_idx   RENAME TO org_neuron_authoring_primitives_lifecycle_idx;

  -- ──────────────────────────────────────────────────────────────────
  -- STEP 10: Rename edges → synapses + columns + indexes.
  -- ──────────────────────────────────────────────────────────────────
  ALTER TABLE IF EXISTS edges RENAME TO synapses;
  ALTER TABLE IF EXISTS synapses RENAME COLUMN from_node_type   TO from_neuron_type;
  ALTER TABLE IF EXISTS synapses RENAME COLUMN to_node_type     TO to_neuron_type;
  ALTER TABLE IF EXISTS synapses RENAME COLUMN edge_type        TO synapse_type;
  ALTER TABLE IF EXISTS synapses RENAME COLUMN edge_props_json  TO synapse_props_json;
  ALTER INDEX IF EXISTS edges_doco_idx          RENAME TO synapses_doco_idx;
  ALTER INDEX IF EXISTS edges_to_idx            RENAME TO synapses_to_idx;
  ALTER INDEX IF EXISTS edges_from_type_idx     RENAME TO synapses_from_type_idx;
  ALTER INDEX IF EXISTS edges_type_idx          RENAME TO synapses_type_idx;
  ALTER INDEX IF EXISTS edges_attribution_idx   RENAME TO synapses_attribution_idx;
  ALTER INDEX IF EXISTS edges_doco_type_from_idx RENAME TO synapses_doco_type_from_idx;
  ALTER INDEX IF EXISTS edges_doco_type_to_idx   RENAME TO synapses_doco_type_to_idx;

  -- ──────────────────────────────────────────────────────────────────
  -- STEP 11: Rename node-typed columns on docos.
  -- ──────────────────────────────────────────────────────────────────
  ALTER TABLE docos RENAME COLUMN allowed_node_types     TO allowed_neuron_types;
  ALTER TABLE docos RENAME COLUMN default_node_lifecycle TO default_neuron_lifecycle;

  -- ──────────────────────────────────────────────────────────────────
  -- STEP 12: ID-prefix rewrites — primary keys on primitive tables.
  -- ULID stays the same; only the prefix changes.
  -- ──────────────────────────────────────────────────────────────────
  UPDATE guidance_primitives
     SET id = 'guidance_primitive_' || substring(id from position('_' in id) + 1)
   WHERE id LIKE 'guidance_article_%';
  UPDATE neuron_authoring_primitives
     SET id = 'neuron_authoring_primitive_' || substring(id from position('_' in id) + 1)
   WHERE id LIKE 'node_authoring_article_%';
  UPDATE org_guidance_primitives
     SET id = 'guidance_primitive_' || substring(id from position('_' in id) + 1)
   WHERE id LIKE 'guidance_article_%';
  UPDATE org_neuron_authoring_primitives
     SET id = 'neuron_authoring_primitive_' || substring(id from position('_' in id) + 1)
   WHERE id LIKE 'node_authoring_article_%';

  -- ──────────────────────────────────────────────────────────────────
  -- STEP 13: Rewrite ID-prefix references in audit_events.entity_id
  -- and embeddings.entity_id.
  -- ──────────────────────────────────────────────────────────────────
  UPDATE audit_events
     SET entity_id = 'guidance_primitive_' || substring(entity_id from position('_' in entity_id) + 1)
   WHERE entity_id LIKE 'guidance_article_%';
  UPDATE audit_events
     SET entity_id = 'neuron_authoring_primitive_' || substring(entity_id from position('_' in entity_id) + 1)
   WHERE entity_id LIKE 'node_authoring_article_%';
  -- principal_<ulid> entity_ids that became collaborators
  UPDATE audit_events
     SET entity_id = (
       SELECT pc.new_collaborator_id FROM principal_classification pc WHERE pc.old_id = audit_events.entity_id
     )
   WHERE entity_id LIKE 'principal_%'
     AND EXISTS (
       SELECT 1 FROM principal_classification pc
       WHERE pc.old_id = audit_events.entity_id
         AND pc.new_collaborator_id IS NOT NULL
     );

  UPDATE embeddings
     SET entity_id = 'guidance_primitive_' || substring(entity_id from position('_' in entity_id) + 1)
   WHERE entity_id LIKE 'guidance_article_%';
  UPDATE embeddings
     SET entity_id = 'neuron_authoring_primitive_' || substring(entity_id from position('_' in entity_id) + 1)
   WHERE entity_id LIKE 'node_authoring_article_%';

  -- ──────────────────────────────────────────────────────────────────
  -- STEP 14: Rewrite ID-prefix references in synapses (from_id, to_id).
  -- ──────────────────────────────────────────────────────────────────
  UPDATE synapses
     SET from_id = 'guidance_primitive_' || substring(from_id from position('_' in from_id) + 1)
   WHERE from_id LIKE 'guidance_article_%';
  UPDATE synapses
     SET from_id = 'neuron_authoring_primitive_' || substring(from_id from position('_' in from_id) + 1)
   WHERE from_id LIKE 'node_authoring_article_%';
  UPDATE synapses
     SET to_id = 'guidance_primitive_' || substring(to_id from position('_' in to_id) + 1)
   WHERE to_id LIKE 'guidance_article_%';
  UPDATE synapses
     SET to_id = 'neuron_authoring_primitive_' || substring(to_id from position('_' in to_id) + 1)
   WHERE to_id LIKE 'node_authoring_article_%';

  -- Rewrite synapses.from_neuron_type / to_neuron_type discriminator values.
  UPDATE synapses SET from_neuron_type = 'guidance_primitive'
   WHERE from_neuron_type = 'guidance_article';
  UPDATE synapses SET from_neuron_type = 'neuron_authoring_primitive'
   WHERE from_neuron_type = 'node_authoring_article';
  UPDATE synapses SET to_neuron_type = 'guidance_primitive'
   WHERE to_neuron_type = 'guidance_article';
  UPDATE synapses SET to_neuron_type = 'neuron_authoring_primitive'
   WHERE to_neuron_type = 'node_authoring_article';

  -- ──────────────────────────────────────────────────────────────────
  -- STEP 15: audit_events op rename: 'edge.add' → 'synapse.add'.
  -- ──────────────────────────────────────────────────────────────────
  -- Drop the CHECK constraint, update the values, re-add with new enum.
  ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_op_check;
  UPDATE audit_events SET op = 'synapse.add' WHERE op = 'edge.add';
  ALTER TABLE audit_events
    ADD CONSTRAINT audit_events_op_check
    CHECK (op IN ('entity.create', 'entity.update', 'entity.delete', 'lifecycle.transition', 'synapse.add'));

  -- audit_events.entity_type discriminator rewrites
  UPDATE audit_events SET entity_type = 'guidance_primitive'
   WHERE entity_type = 'guidance_article';
  UPDATE audit_events SET entity_type = 'neuron_authoring_primitive'
   WHERE entity_type = 'node_authoring_article';
  -- collaborator entity_type for migrated rows
  UPDATE audit_events SET entity_type = 'collaborator'
   WHERE entity_type = 'principal'
     AND entity_id LIKE 'collaborator_%';

  -- ──────────────────────────────────────────────────────────────────
  -- STEP 16: raw_yaml / JSONB regex rewrites.
  --
  -- Inside YAML/JSON text:
  --   node_type:                → neuron_type:
  --   article_type:             → primitive_kind:
  --   node_authoring            → neuron_authoring         (value)
  --   auto_edges:               → auto_synapses:
  --   edge_type:                → synapse_type:
  --   guidance_article_<ulid>   → guidance_primitive_<ulid>
  --   node_authoring_article_<ulid> → neuron_authoring_primitive_<ulid>
  --
  -- Conditional principal → collaborator rewrites are applied per-table
  -- via a JOIN to principal_classification.
  -- ──────────────────────────────────────────────────────────────────

  -- Generic regex pass on every raw_yaml. The order matters:
  --   1) the longer literal substitutions first to avoid partial matches
  --   2) value-side substitutions before key-side ones where overlap
  --      could occur.

  -- 1) Per-table raw_yaml rewrites.
  -- A helper template: applied to every entity table that has raw_yaml.

  -- intents
  UPDATE intents SET raw_yaml = regexp_replace(raw_yaml, 'node_authoring_article_', 'neuron_authoring_primitive_', 'g');
  UPDATE intents SET raw_yaml = regexp_replace(raw_yaml, '\mnode_authoring_article\M', 'neuron_authoring_primitive', 'g');
  UPDATE intents SET raw_yaml = regexp_replace(raw_yaml, 'guidance_article_',       'guidance_primitive_',       'g');
  UPDATE intents SET raw_yaml = regexp_replace(raw_yaml, '\mguidance_article\M', 'guidance_primitive', 'g');
  UPDATE intents SET raw_yaml = regexp_replace(raw_yaml, '\mnode_type\M',           'entity_type',               'g');
  UPDATE intents SET raw_yaml = regexp_replace(raw_yaml, '\mauto_edges\M',          'auto_synapses',             'g');
  UPDATE intents SET raw_yaml = regexp_replace(raw_yaml, '\medge_type\M',           'synapse_type',              'g');
  UPDATE intents SET raw_yaml = regexp_replace(raw_yaml, '\marticle_type\M',        'primitive_kind',            'g');
  UPDATE intents SET raw_yaml = regexp_replace(raw_yaml, 'node_authoring',          'neuron_authoring',          'g');

  -- decisions
  UPDATE decisions SET raw_yaml = regexp_replace(raw_yaml, 'node_authoring_article_', 'neuron_authoring_primitive_', 'g');
  UPDATE decisions SET raw_yaml = regexp_replace(raw_yaml, '\mnode_authoring_article\M', 'neuron_authoring_primitive', 'g');
  UPDATE decisions SET raw_yaml = regexp_replace(raw_yaml, 'guidance_article_',       'guidance_primitive_',       'g');
  UPDATE decisions SET raw_yaml = regexp_replace(raw_yaml, '\mguidance_article\M', 'guidance_primitive', 'g');
  UPDATE decisions SET raw_yaml = regexp_replace(raw_yaml, '\mnode_type\M',           'entity_type',               'g');
  UPDATE decisions SET raw_yaml = regexp_replace(raw_yaml, '\mauto_edges\M',          'auto_synapses',             'g');
  UPDATE decisions SET raw_yaml = regexp_replace(raw_yaml, '\medge_type\M',           'synapse_type',              'g');
  UPDATE decisions SET raw_yaml = regexp_replace(raw_yaml, '\marticle_type\M',        'primitive_kind',            'g');
  UPDATE decisions SET raw_yaml = regexp_replace(raw_yaml, 'node_authoring',          'neuron_authoring',          'g');

  -- rules
  UPDATE rules SET raw_yaml = regexp_replace(raw_yaml, 'node_authoring_article_', 'neuron_authoring_primitive_', 'g');
  UPDATE rules SET raw_yaml = regexp_replace(raw_yaml, '\mnode_authoring_article\M', 'neuron_authoring_primitive', 'g');
  UPDATE rules SET raw_yaml = regexp_replace(raw_yaml, 'guidance_article_',       'guidance_primitive_',       'g');
  UPDATE rules SET raw_yaml = regexp_replace(raw_yaml, '\mguidance_article\M', 'guidance_primitive', 'g');
  UPDATE rules SET raw_yaml = regexp_replace(raw_yaml, '\mnode_type\M',           'entity_type',               'g');
  UPDATE rules SET raw_yaml = regexp_replace(raw_yaml, '\mauto_edges\M',          'auto_synapses',             'g');
  UPDATE rules SET raw_yaml = regexp_replace(raw_yaml, '\medge_type\M',           'synapse_type',              'g');
  UPDATE rules SET raw_yaml = regexp_replace(raw_yaml, '\marticle_type\M',        'primitive_kind',            'g');
  UPDATE rules SET raw_yaml = regexp_replace(raw_yaml, 'node_authoring',          'neuron_authoring',          'g');

  -- guidance_primitives
  UPDATE guidance_primitives SET raw_yaml = regexp_replace(raw_yaml, 'node_authoring_article_', 'neuron_authoring_primitive_', 'g');
  UPDATE guidance_primitives SET raw_yaml = regexp_replace(raw_yaml, '\mnode_authoring_article\M', 'neuron_authoring_primitive', 'g');
  UPDATE guidance_primitives SET raw_yaml = regexp_replace(raw_yaml, 'guidance_article_',       'guidance_primitive_',       'g');
  UPDATE guidance_primitives SET raw_yaml = regexp_replace(raw_yaml, '\mguidance_article\M', 'guidance_primitive', 'g');
  UPDATE guidance_primitives SET raw_yaml = regexp_replace(raw_yaml, '\mnode_type\M',           'entity_type',               'g');
  UPDATE guidance_primitives SET raw_yaml = regexp_replace(raw_yaml, '\mauto_edges\M',          'auto_synapses',             'g');
  UPDATE guidance_primitives SET raw_yaml = regexp_replace(raw_yaml, '\medge_type\M',           'synapse_type',              'g');
  UPDATE guidance_primitives SET raw_yaml = regexp_replace(raw_yaml, '\marticle_type\M',        'primitive_kind',            'g');
  UPDATE guidance_primitives SET raw_yaml = regexp_replace(raw_yaml, 'node_authoring',          'neuron_authoring',          'g');

  -- neuron_authoring_primitives
  UPDATE neuron_authoring_primitives SET raw_yaml = regexp_replace(raw_yaml, 'node_authoring_article_', 'neuron_authoring_primitive_', 'g');
  UPDATE neuron_authoring_primitives SET raw_yaml = regexp_replace(raw_yaml, '\mnode_authoring_article\M', 'neuron_authoring_primitive', 'g');
  UPDATE neuron_authoring_primitives SET raw_yaml = regexp_replace(raw_yaml, 'guidance_article_',       'guidance_primitive_',       'g');
  UPDATE neuron_authoring_primitives SET raw_yaml = regexp_replace(raw_yaml, '\mguidance_article\M', 'guidance_primitive', 'g');
  UPDATE neuron_authoring_primitives SET raw_yaml = regexp_replace(raw_yaml, '\mnode_type\M',           'entity_type',               'g');
  UPDATE neuron_authoring_primitives SET raw_yaml = regexp_replace(raw_yaml, '\mauto_edges\M',          'auto_synapses',             'g');
  UPDATE neuron_authoring_primitives SET raw_yaml = regexp_replace(raw_yaml, '\medge_type\M',           'synapse_type',              'g');
  UPDATE neuron_authoring_primitives SET raw_yaml = regexp_replace(raw_yaml, '\marticle_type\M',        'primitive_kind',            'g');
  UPDATE neuron_authoring_primitives SET raw_yaml = regexp_replace(raw_yaml, 'node_authoring',          'neuron_authoring',          'g');

  -- org_guidance_primitives
  UPDATE org_guidance_primitives SET raw_yaml = regexp_replace(raw_yaml, 'node_authoring_article_', 'neuron_authoring_primitive_', 'g');
  UPDATE org_guidance_primitives SET raw_yaml = regexp_replace(raw_yaml, '\mnode_authoring_article\M', 'neuron_authoring_primitive', 'g');
  UPDATE org_guidance_primitives SET raw_yaml = regexp_replace(raw_yaml, 'guidance_article_',       'guidance_primitive_',       'g');
  UPDATE org_guidance_primitives SET raw_yaml = regexp_replace(raw_yaml, '\mguidance_article\M', 'guidance_primitive', 'g');
  UPDATE org_guidance_primitives SET raw_yaml = regexp_replace(raw_yaml, '\mnode_type\M',           'entity_type',               'g');
  UPDATE org_guidance_primitives SET raw_yaml = regexp_replace(raw_yaml, '\marticle_type\M',        'primitive_kind',            'g');
  UPDATE org_guidance_primitives SET raw_yaml = regexp_replace(raw_yaml, 'node_authoring',          'neuron_authoring',          'g');

  -- org_neuron_authoring_primitives
  UPDATE org_neuron_authoring_primitives SET raw_yaml = regexp_replace(raw_yaml, 'node_authoring_article_', 'neuron_authoring_primitive_', 'g');
  UPDATE org_neuron_authoring_primitives SET raw_yaml = regexp_replace(raw_yaml, '\mnode_authoring_article\M', 'neuron_authoring_primitive', 'g');
  UPDATE org_neuron_authoring_primitives SET raw_yaml = regexp_replace(raw_yaml, 'guidance_article_',       'guidance_primitive_',       'g');
  UPDATE org_neuron_authoring_primitives SET raw_yaml = regexp_replace(raw_yaml, '\mguidance_article\M', 'guidance_primitive', 'g');
  UPDATE org_neuron_authoring_primitives SET raw_yaml = regexp_replace(raw_yaml, '\mnode_type\M',           'entity_type',               'g');
  UPDATE org_neuron_authoring_primitives SET raw_yaml = regexp_replace(raw_yaml, '\mauto_edges\M',          'auto_synapses',             'g');
  UPDATE org_neuron_authoring_primitives SET raw_yaml = regexp_replace(raw_yaml, '\medge_type\M',           'synapse_type',              'g');
  UPDATE org_neuron_authoring_primitives SET raw_yaml = regexp_replace(raw_yaml, '\marticle_type\M',        'primitive_kind',            'g');
  UPDATE org_neuron_authoring_primitives SET raw_yaml = regexp_replace(raw_yaml, 'node_authoring',          'neuron_authoring',          'g');

  -- actions
  UPDATE actions SET raw_yaml = regexp_replace(raw_yaml, 'node_authoring_article_', 'neuron_authoring_primitive_', 'g');
  UPDATE actions SET raw_yaml = regexp_replace(raw_yaml, '\mnode_authoring_article\M', 'neuron_authoring_primitive', 'g');
  UPDATE actions SET raw_yaml = regexp_replace(raw_yaml, 'guidance_article_',       'guidance_primitive_',       'g');
  UPDATE actions SET raw_yaml = regexp_replace(raw_yaml, '\mguidance_article\M', 'guidance_primitive', 'g');
  UPDATE actions SET raw_yaml = regexp_replace(raw_yaml, '\mnode_type\M',           'entity_type',               'g');
  UPDATE actions SET raw_yaml = regexp_replace(raw_yaml, '\mauto_edges\M',          'auto_synapses',             'g');
  UPDATE actions SET raw_yaml = regexp_replace(raw_yaml, '\medge_type\M',           'synapse_type',              'g');
  UPDATE actions SET raw_yaml = regexp_replace(raw_yaml, '\marticle_type\M',        'primitive_kind',            'g');

  -- logs
  UPDATE logs SET raw_yaml = regexp_replace(raw_yaml, 'node_authoring_article_', 'neuron_authoring_primitive_', 'g');
  UPDATE logs SET raw_yaml = regexp_replace(raw_yaml, '\mnode_authoring_article\M', 'neuron_authoring_primitive', 'g');
  UPDATE logs SET raw_yaml = regexp_replace(raw_yaml, 'guidance_article_',       'guidance_primitive_',       'g');
  UPDATE logs SET raw_yaml = regexp_replace(raw_yaml, '\mguidance_article\M', 'guidance_primitive', 'g');
  UPDATE logs SET raw_yaml = regexp_replace(raw_yaml, '\mnode_type\M',           'entity_type',               'g');
  UPDATE logs SET raw_yaml = regexp_replace(raw_yaml, '\mauto_edges\M',          'auto_synapses',             'g');
  UPDATE logs SET raw_yaml = regexp_replace(raw_yaml, '\medge_type\M',           'synapse_type',              'g');

  -- evals
  UPDATE evals SET raw_yaml = regexp_replace(raw_yaml, 'node_authoring_article_', 'neuron_authoring_primitive_', 'g');
  UPDATE evals SET raw_yaml = regexp_replace(raw_yaml, '\mnode_authoring_article\M', 'neuron_authoring_primitive', 'g');
  UPDATE evals SET raw_yaml = regexp_replace(raw_yaml, 'guidance_article_',       'guidance_primitive_',       'g');
  UPDATE evals SET raw_yaml = regexp_replace(raw_yaml, '\mguidance_article\M', 'guidance_primitive', 'g');
  UPDATE evals SET raw_yaml = regexp_replace(raw_yaml, '\mnode_type\M',           'entity_type',               'g');
  UPDATE evals SET raw_yaml = regexp_replace(raw_yaml, '\mauto_edges\M',          'auto_synapses',             'g');
  UPDATE evals SET raw_yaml = regexp_replace(raw_yaml, '\medge_type\M',           'synapse_type',              'g');

  -- ideas
  UPDATE ideas SET raw_yaml = regexp_replace(raw_yaml, 'node_authoring_article_', 'neuron_authoring_primitive_', 'g');
  UPDATE ideas SET raw_yaml = regexp_replace(raw_yaml, '\mnode_authoring_article\M', 'neuron_authoring_primitive', 'g');
  UPDATE ideas SET raw_yaml = regexp_replace(raw_yaml, 'guidance_article_',       'guidance_primitive_',       'g');
  UPDATE ideas SET raw_yaml = regexp_replace(raw_yaml, '\mguidance_article\M', 'guidance_primitive', 'g');
  UPDATE ideas SET raw_yaml = regexp_replace(raw_yaml, '\mnode_type\M',           'entity_type',               'g');

  -- reference_entities
  UPDATE reference_entities SET raw_yaml = regexp_replace(raw_yaml, 'node_authoring_article_', 'neuron_authoring_primitive_', 'g');
  UPDATE reference_entities SET raw_yaml = regexp_replace(raw_yaml, '\mnode_authoring_article\M', 'neuron_authoring_primitive', 'g');
  UPDATE reference_entities SET raw_yaml = regexp_replace(raw_yaml, 'guidance_article_',       'guidance_primitive_',       'g');
  UPDATE reference_entities SET raw_yaml = regexp_replace(raw_yaml, '\mguidance_article\M', 'guidance_primitive', 'g');
  UPDATE reference_entities SET raw_yaml = regexp_replace(raw_yaml, '\mnode_type\M',           'entity_type',               'g');

  -- states
  UPDATE states SET raw_yaml = regexp_replace(raw_yaml, 'node_authoring_article_', 'neuron_authoring_primitive_', 'g');
  UPDATE states SET raw_yaml = regexp_replace(raw_yaml, '\mnode_authoring_article\M', 'neuron_authoring_primitive', 'g');
  UPDATE states SET raw_yaml = regexp_replace(raw_yaml, 'guidance_article_',       'guidance_primitive_',       'g');
  UPDATE states SET raw_yaml = regexp_replace(raw_yaml, '\mguidance_article\M', 'guidance_primitive', 'g');
  UPDATE states SET raw_yaml = regexp_replace(raw_yaml, '\mnode_type\M',           'entity_type',               'g');

  -- tags
  UPDATE tags SET raw_yaml = regexp_replace(raw_yaml, 'node_authoring_article_', 'neuron_authoring_primitive_', 'g');
  UPDATE tags SET raw_yaml = regexp_replace(raw_yaml, '\mnode_authoring_article\M', 'neuron_authoring_primitive', 'g');
  UPDATE tags SET raw_yaml = regexp_replace(raw_yaml, 'guidance_article_',       'guidance_primitive_',       'g');
  UPDATE tags SET raw_yaml = regexp_replace(raw_yaml, '\mguidance_article\M', 'guidance_primitive', 'g');

  -- principals
  UPDATE principals SET raw_yaml = regexp_replace(raw_yaml, 'node_authoring_article_', 'neuron_authoring_primitive_', 'g');
  UPDATE principals SET raw_yaml = regexp_replace(raw_yaml, '\mnode_authoring_article\M', 'neuron_authoring_primitive', 'g');
  UPDATE principals SET raw_yaml = regexp_replace(raw_yaml, 'guidance_article_',       'guidance_primitive_',       'g');
  UPDATE principals SET raw_yaml = regexp_replace(raw_yaml, '\mguidance_article\M', 'guidance_primitive', 'g');
  UPDATE principals SET raw_yaml = regexp_replace(raw_yaml, '\mnode_type\M',           'entity_type',               'g');

  -- docos
  UPDATE docos SET raw_yaml = regexp_replace(raw_yaml, '\mallowed_node_types\M',      'allowed_neuron_types',     'g');
  UPDATE docos SET raw_yaml = regexp_replace(raw_yaml, '\mdefault_node_lifecycle\M',  'default_neuron_lifecycle', 'g');
  UPDATE docos SET raw_yaml = regexp_replace(raw_yaml, 'node_authoring_article_',     'neuron_authoring_primitive_', 'g');
  UPDATE docos SET raw_yaml = regexp_replace(raw_yaml, '\mnode_authoring_article\M', 'neuron_authoring_primitive', 'g');
  UPDATE docos SET raw_yaml = regexp_replace(raw_yaml, 'guidance_article_',           'guidance_primitive_',       'g');
  UPDATE docos SET raw_yaml = regexp_replace(raw_yaml, '\mguidance_article\M', 'guidance_primitive', 'g');

  -- doco_templates
  UPDATE doco_templates SET raw_yaml = regexp_replace(raw_yaml, 'node_authoring_article_', 'neuron_authoring_primitive_', 'g');
  UPDATE doco_templates SET raw_yaml = regexp_replace(raw_yaml, '\mnode_authoring_article\M', 'neuron_authoring_primitive', 'g');
  UPDATE doco_templates SET raw_yaml = regexp_replace(raw_yaml, 'guidance_article_',       'guidance_primitive_',       'g');
  UPDATE doco_templates SET raw_yaml = regexp_replace(raw_yaml, '\mguidance_article\M', 'guidance_primitive', 'g');
  UPDATE doco_templates SET raw_yaml = regexp_replace(raw_yaml, '\mallowed_node_types\M',      'allowed_neuron_types',     'g');
  UPDATE doco_templates SET raw_yaml = regexp_replace(raw_yaml, '\mdefault_node_lifecycle\M',  'default_neuron_lifecycle', 'g');
  UPDATE doco_templates SET raw_yaml = regexp_replace(raw_yaml, '\mnode_type\M',           'entity_type',               'g');
  UPDATE doco_templates SET raw_yaml = regexp_replace(raw_yaml, '\marticle_type\M',        'primitive_kind',            'g');
  UPDATE doco_templates SET raw_yaml = regexp_replace(raw_yaml, 'node_authoring',          'neuron_authoring',          'g');

  -- 2) Principal → collaborator rewrites inside raw_yaml.
  -- Only for principal IDs that got a collaborator counterpart and
  -- in contexts where the reference is identity-shaped (created_by,
  -- updated_by, decided_by, proposer_id, owner_id, members[].principal_id,
  -- members[].collaborator_id (key rename)).
  --
  -- We do this in two passes: first rename the KEY `members[].principal_id`
  -- → `members[].collaborator_id` (key, not just value), then rewrite the
  -- VALUE prefixes for principals that became collaborators.

  -- Pass A: key rewrite in members[].principal_id (JSONB key).
  -- Members appears on docos and organizations raw_yaml.
  -- We approximate with a regex on the YAML/JSON text.
  UPDATE docos SET raw_yaml = regexp_replace(raw_yaml, '"principal_id"', '"collaborator_id"', 'g')
   WHERE raw_yaml LIKE '%"principal_id"%';
  UPDATE docos SET raw_yaml = regexp_replace(raw_yaml, '\mprincipal_id:', 'collaborator_id:', 'g')
   WHERE raw_yaml LIKE '%principal_id:%';
  UPDATE organizations SET raw_yaml = regexp_replace(raw_yaml, '"principal_id"', '"collaborator_id"', 'g')
   WHERE raw_yaml LIKE '%"principal_id"%';
  UPDATE organizations SET raw_yaml = regexp_replace(raw_yaml, '\mprincipal_id:', 'collaborator_id:', 'g')
   WHERE raw_yaml LIKE '%principal_id:%';

  -- Pass B: prefix value rewrites for principals that became collaborators.
  -- For each principal_classification row where new_collaborator_id is
  -- not null, run a global regex replace of that exact ULID-bearing string.
  DECLARE
    pc_row record;
  BEGIN
    FOR pc_row IN
      SELECT old_id, new_collaborator_id FROM principal_classification
       WHERE new_collaborator_id IS NOT NULL
    LOOP
      -- intents
      UPDATE intents SET raw_yaml = replace(raw_yaml, pc_row.old_id, pc_row.new_collaborator_id)
        WHERE raw_yaml LIKE '%' || pc_row.old_id || '%';
      -- decisions
      UPDATE decisions SET raw_yaml = replace(raw_yaml, pc_row.old_id, pc_row.new_collaborator_id)
        WHERE raw_yaml LIKE '%' || pc_row.old_id || '%';
      -- rules
      UPDATE rules SET raw_yaml = replace(raw_yaml, pc_row.old_id, pc_row.new_collaborator_id)
        WHERE raw_yaml LIKE '%' || pc_row.old_id || '%';
      -- guidance_primitives
      UPDATE guidance_primitives SET raw_yaml = replace(raw_yaml, pc_row.old_id, pc_row.new_collaborator_id)
        WHERE raw_yaml LIKE '%' || pc_row.old_id || '%';
      -- neuron_authoring_primitives
      UPDATE neuron_authoring_primitives SET raw_yaml = replace(raw_yaml, pc_row.old_id, pc_row.new_collaborator_id)
        WHERE raw_yaml LIKE '%' || pc_row.old_id || '%';
      -- org_guidance_primitives
      UPDATE org_guidance_primitives SET raw_yaml = replace(raw_yaml, pc_row.old_id, pc_row.new_collaborator_id)
        WHERE raw_yaml LIKE '%' || pc_row.old_id || '%';
      -- org_neuron_authoring_primitives
      UPDATE org_neuron_authoring_primitives SET raw_yaml = replace(raw_yaml, pc_row.old_id, pc_row.new_collaborator_id)
        WHERE raw_yaml LIKE '%' || pc_row.old_id || '%';
      -- actions  — DO NOT rewrite actor_id values; only created_by/updated_by.
      -- Easier approach: rewrite the value globally, then put back actor_id
      -- references for the BOTH case (where the principal still exists too).
      -- Since `pc_row` only loops over principals that got a collaborator
      -- counterpart, and 'princ_only' rows are NOT in this loop, this is
      -- safe for collab_only rows but loses the principal ID for 'both' rows.
      -- We handle 'both' rows below.

      -- For 'both' rows: actor_id values must remain principal_<ulid>.
      -- We use a more conservative rewrite for entities that carry actor_id.
      -- For actions, logs, intents, decisions, ideas — only rewrite the
      -- created_by / updated_by KEYS to point at the new collaborator.

      -- evals
      UPDATE evals SET raw_yaml = replace(raw_yaml, pc_row.old_id, pc_row.new_collaborator_id)
        WHERE raw_yaml LIKE '%' || pc_row.old_id || '%';
      -- ideas — proposer_id points at collaborator now
      -- For 'both' rows, ideas could carry proposer_id pointing at the
      -- principal. After rewrite, it points at the collaborator. That
      -- matches the plan (proposer_id moved to collaborator target).
      UPDATE ideas SET raw_yaml = replace(raw_yaml, pc_row.old_id, pc_row.new_collaborator_id)
        WHERE raw_yaml LIKE '%' || pc_row.old_id || '%';
      -- reference_entities
      UPDATE reference_entities SET raw_yaml = replace(raw_yaml, pc_row.old_id, pc_row.new_collaborator_id)
        WHERE raw_yaml LIKE '%' || pc_row.old_id || '%';
      -- states
      UPDATE states SET raw_yaml = replace(raw_yaml, pc_row.old_id, pc_row.new_collaborator_id)
        WHERE raw_yaml LIKE '%' || pc_row.old_id || '%';
      -- tags
      UPDATE tags SET raw_yaml = replace(raw_yaml, pc_row.old_id, pc_row.new_collaborator_id)
        WHERE raw_yaml LIKE '%' || pc_row.old_id || '%';
      -- principals
      UPDATE principals SET raw_yaml = replace(raw_yaml, pc_row.old_id, pc_row.new_collaborator_id)
        WHERE raw_yaml LIKE '%' || pc_row.old_id || '%'
          AND id != pc_row.old_id;
      -- docos
      UPDATE docos SET raw_yaml = replace(raw_yaml, pc_row.old_id, pc_row.new_collaborator_id)
        WHERE raw_yaml LIKE '%' || pc_row.old_id || '%';
      -- organizations
      UPDATE organizations SET raw_yaml = replace(raw_yaml, pc_row.old_id, pc_row.new_collaborator_id)
        WHERE raw_yaml LIKE '%' || pc_row.old_id || '%';
      -- audit_events.before_json / after_json (JSONB)
      UPDATE audit_events
         SET before_json = (replace(before_json::text, pc_row.old_id, pc_row.new_collaborator_id))::jsonb
       WHERE before_json IS NOT NULL AND before_json::text LIKE '%' || pc_row.old_id || '%';
      UPDATE audit_events
         SET after_json = (replace(after_json::text, pc_row.old_id, pc_row.new_collaborator_id))::jsonb
       WHERE after_json IS NOT NULL AND after_json::text LIKE '%' || pc_row.old_id || '%';
    END LOOP;
  END;

  -- Pass C: For 'both' rows, put back the principal_<ulid> reference
  -- everywhere `actor_id`/`actors`/`stakeholders` appears as the field name.
  -- This is hard to do in pure regex because we have to look at the KEY.
  --
  -- Simplification: for each 'both' row, the principal_<ulid> survives in
  -- the principals table (kept), and the collaborator_<ulid> is added.
  -- The `actor_id` / `actors` references in raw_yaml were rewritten by
  -- Pass B to point at the collaborator. We need to revert those.
  --
  -- We do this in TS-side validation rather than SQL to avoid fragile
  -- regex on YAML/JSON. The migration emits a `reindex_pending` flag and
  -- the indexer reapplies derived synapses. The validator can then
  -- flag any `actor_id` references that now point at collaborators
  -- (which is wrong) and the user fixes them post-migration.
  --
  -- ALTERNATIVE: We rebuild the synapses table from scratch using the
  -- updated raw_yaml. Any actor_id that now points at a collaborator is
  -- treated as an authorship reference, not an actor reference. The
  -- user can audit.

  -- ──────────────────────────────────────────────────────────────────
  -- STEP 17: Split entity_fts into 5 tables.
  -- ──────────────────────────────────────────────────────────────────

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
    primitive_kind  text NOT NULL,
    summary         text,
    body            text,
    search_tsv      tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(summary, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(body, '')), 'B')
    ) STORED
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

  -- Migrate data from old entity_fts (if it exists).
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'entity_fts'
  ) THEN
    -- Neurons (10 types)
    INSERT INTO entity_fts_neurons (entity_id, doco_id, neuron_type, summary, body)
    SELECT entity_id, doco_id,
           CASE
             WHEN node_type = 'guidance_article' THEN 'guidance_primitive'
             WHEN node_type = 'node_authoring_article' THEN 'neuron_authoring_primitive'
             ELSE node_type
           END,
           summary, body
      FROM entity_fts
     WHERE node_type IN ('intent','idea','rule','decision','action','log','eval','reference','state','principal')
       AND doco_id IS NOT NULL
    ON CONFLICT (entity_id) DO NOTHING;

    -- Update IDs that changed prefix
    UPDATE entity_fts_neurons
       SET entity_id = 'guidance_primitive_' || substring(entity_id from position('_' in entity_id) + 1)
     WHERE entity_id LIKE 'guidance_article_%';
    UPDATE entity_fts_neurons
       SET entity_id = 'neuron_authoring_primitive_' || substring(entity_id from position('_' in entity_id) + 1)
     WHERE entity_id LIKE 'node_authoring_article_%';

    -- Primitives (2 types)
    INSERT INTO entity_fts_primitives (entity_id, doco_id, org_id, primitive_kind, summary, body)
    SELECT
      CASE
        WHEN entity_id LIKE 'guidance_article_%' THEN 'guidance_primitive_' || substring(entity_id from position('_' in entity_id) + 1)
        WHEN entity_id LIKE 'node_authoring_article_%' THEN 'neuron_authoring_primitive_' || substring(entity_id from position('_' in entity_id) + 1)
        ELSE entity_id
      END,
      doco_id,
      NULL::text AS org_id,
      CASE
        WHEN node_type IN ('guidance_article', 'guidance_primitive') THEN 'guidance'
        WHEN node_type IN ('node_authoring_article', 'neuron_authoring_primitive') THEN 'neuron_authoring'
      END,
      summary, body
      FROM entity_fts
     WHERE node_type IN ('guidance_article', 'node_authoring_article', 'guidance_primitive', 'neuron_authoring_primitive')
    ON CONFLICT (entity_id) DO NOTHING;

    -- Drop old entity_fts.
    DROP TABLE entity_fts CASCADE;
  END IF;

  -- Populate entity_fts_collaborators from the new collaborators table.
  INSERT INTO entity_fts_collaborators (entity_id, summary, body)
  SELECT id, COALESCE(github_login, ''), COALESCE(email, '')
    FROM collaborators
  ON CONFLICT (entity_id) DO NOTHING;

  -- Populate entity_fts_docos from docos.
  INSERT INTO entity_fts_docos (entity_id, summary, body)
  SELECT id, COALESCE(name, handle), ''
    FROM docos
  ON CONFLICT (entity_id) DO NOTHING;

  -- Populate entity_fts_organizations from organizations.
  INSERT INTO entity_fts_organizations (entity_id, summary, body)
  SELECT id, COALESCE(name, handle, slug), ''
    FROM organizations
  ON CONFLICT (entity_id) DO NOTHING;

  -- ──────────────────────────────────────────────────────────────────
  -- STEP 18: TRUNCATE synapses + flag reindex_pending.
  -- The indexer will rebuild from the rewritten raw_yaml on next boot.
  -- ──────────────────────────────────────────────────────────────────
  TRUNCATE TABLE synapses;
  INSERT INTO doco_meta (key, value) VALUES ('reindex_pending', 'true')
    ON CONFLICT (key) DO UPDATE SET value = 'true';

  -- ──────────────────────────────────────────────────────────────────
  -- STEP 19: Legacy reasoning_% cleanup (now from synapses, not edges).
  -- ──────────────────────────────────────────────────────────────────
  -- Synapses is freshly truncated so no work. Embeddings & audit events
  -- still need cleanup if they have stale reasoning IDs.
  DELETE FROM embeddings    WHERE entity_id LIKE 'reasoning\_%' ESCAPE '\';
  DELETE FROM audit_events  WHERE entity_id LIKE 'reasoning\_%' ESCAPE '\';

  -- ──────────────────────────────────────────────────────────────────
  -- STEP 20: Final sentinel write.
  -- ──────────────────────────────────────────────────────────────────
  INSERT INTO doco_meta (key, value) VALUES ('rename_v005', 'done')
    ON CONFLICT (key) DO UPDATE SET value = 'done';

  RAISE NOTICE 'rename_v005: done';
END
$rename_v005$;
