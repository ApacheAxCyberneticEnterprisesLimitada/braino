-- 060_collapse_roles_and_lifecycle.sql
-- ============================================================
-- Collapses the access-role ladder and the neuron lifecycle to the
-- redesigned model:
--
--   roles:     owner / approver / author / reader  ->  owner / writer / reader
--   lifecycle: drafting / proposed / accepted / retired
--                -> drafting / asserted / retired
--
-- "approver" and "author" both fold into "writer": anyone with write
-- access may add, edit, retire, and transition the lifecycle of any
-- neuron or synapse; owners additionally administer the Doco. The old
-- approver tier (lifecycle-transition gate) no longer exists.
--
-- "proposed" folds into "drafting" (the tentative, work-in-progress
-- state agents reach for when a client says they are drafting rather
-- than asserting); "accepted" becomes "asserted".
--
-- Lifecycle is stored twice per neuron/policy row: the typed
-- `lifecycle` text column AND a mirror inside the denormalized `data`
-- jsonb bag. Both are rewritten here.
--
-- The runner wraps each migration in a single BEGIN/COMMIT and records
-- it in applied_migrations, so this file omits transaction control.
-- Every statement is guarded so the migration is idempotent.
-- ============================================================

-- 1. Convert existing role grants BEFORE tightening the CHECK.
UPDATE doco_users SET role = 'writer' WHERE role IN ('author', 'approver');
UPDATE org_users  SET role = 'writer' WHERE role IN ('author', 'approver');
UPDATE oauth_device_authorizations SET requested_role = 'writer'
 WHERE requested_role IN ('author', 'approver');

-- 2. Swap the role CHECK constraints to the three-role set. The inline
--    constraints in schema.sql get Postgres's auto-generated names.
ALTER TABLE doco_users DROP CONSTRAINT IF EXISTS doco_users_role_check;
ALTER TABLE doco_users ADD CONSTRAINT doco_users_role_check
  CHECK (role IN ('owner', 'writer', 'reader'));
ALTER TABLE org_users DROP CONSTRAINT IF EXISTS org_users_role_check;
ALTER TABLE org_users ADD CONSTRAINT org_users_role_check
  CHECK (role IN ('owner', 'writer', 'reader'));
ALTER TABLE oauth_device_authorizations
  DROP CONSTRAINT IF EXISTS oauth_device_authorizations_requested_role_check;
ALTER TABLE oauth_device_authorizations
  ADD CONSTRAINT oauth_device_authorizations_requested_role_check
  CHECK (requested_role IS NULL OR requested_role IN ('reader', 'writer', 'owner'));

-- 3. Typed lifecycle column on the 12 neuron/policy tables.
UPDATE principals                SET lifecycle = 'drafting' WHERE lifecycle = 'proposed';
UPDATE intents                   SET lifecycle = 'drafting' WHERE lifecycle = 'proposed';
UPDATE decisions                 SET lifecycle = 'drafting' WHERE lifecycle = 'proposed';
UPDATE rules                     SET lifecycle = 'drafting' WHERE lifecycle = 'proposed';
UPDATE guidance_policies         SET lifecycle = 'drafting' WHERE lifecycle = 'proposed';
UPDATE neuron_authoring_policies SET lifecycle = 'drafting' WHERE lifecycle = 'proposed';
UPDATE actions                   SET lifecycle = 'drafting' WHERE lifecycle = 'proposed';
UPDATE logs                      SET lifecycle = 'drafting' WHERE lifecycle = 'proposed';
UPDATE evals                     SET lifecycle = 'drafting' WHERE lifecycle = 'proposed';
UPDATE states                    SET lifecycle = 'drafting' WHERE lifecycle = 'proposed';
UPDATE ideas                     SET lifecycle = 'drafting' WHERE lifecycle = 'proposed';
UPDATE reference_entities        SET lifecycle = 'drafting' WHERE lifecycle = 'proposed';

UPDATE principals                SET lifecycle = 'asserted' WHERE lifecycle = 'accepted';
UPDATE intents                   SET lifecycle = 'asserted' WHERE lifecycle = 'accepted';
UPDATE decisions                 SET lifecycle = 'asserted' WHERE lifecycle = 'accepted';
UPDATE rules                     SET lifecycle = 'asserted' WHERE lifecycle = 'accepted';
UPDATE guidance_policies         SET lifecycle = 'asserted' WHERE lifecycle = 'accepted';
UPDATE neuron_authoring_policies SET lifecycle = 'asserted' WHERE lifecycle = 'accepted';
UPDATE actions                   SET lifecycle = 'asserted' WHERE lifecycle = 'accepted';
UPDATE logs                      SET lifecycle = 'asserted' WHERE lifecycle = 'accepted';
UPDATE evals                     SET lifecycle = 'asserted' WHERE lifecycle = 'accepted';
UPDATE states                    SET lifecycle = 'asserted' WHERE lifecycle = 'accepted';
UPDATE ideas                     SET lifecycle = 'asserted' WHERE lifecycle = 'accepted';
UPDATE reference_entities        SET lifecycle = 'asserted' WHERE lifecycle = 'accepted';

-- 4. The lifecycle mirror inside each row's `data` jsonb bag.
UPDATE principals                SET data = jsonb_set(data, '{lifecycle}', '"drafting"'::jsonb) WHERE data->>'lifecycle' = 'proposed';
UPDATE intents                   SET data = jsonb_set(data, '{lifecycle}', '"drafting"'::jsonb) WHERE data->>'lifecycle' = 'proposed';
UPDATE decisions                 SET data = jsonb_set(data, '{lifecycle}', '"drafting"'::jsonb) WHERE data->>'lifecycle' = 'proposed';
UPDATE rules                     SET data = jsonb_set(data, '{lifecycle}', '"drafting"'::jsonb) WHERE data->>'lifecycle' = 'proposed';
UPDATE guidance_policies         SET data = jsonb_set(data, '{lifecycle}', '"drafting"'::jsonb) WHERE data->>'lifecycle' = 'proposed';
UPDATE neuron_authoring_policies SET data = jsonb_set(data, '{lifecycle}', '"drafting"'::jsonb) WHERE data->>'lifecycle' = 'proposed';
UPDATE actions                   SET data = jsonb_set(data, '{lifecycle}', '"drafting"'::jsonb) WHERE data->>'lifecycle' = 'proposed';
UPDATE logs                      SET data = jsonb_set(data, '{lifecycle}', '"drafting"'::jsonb) WHERE data->>'lifecycle' = 'proposed';
UPDATE evals                     SET data = jsonb_set(data, '{lifecycle}', '"drafting"'::jsonb) WHERE data->>'lifecycle' = 'proposed';
UPDATE states                    SET data = jsonb_set(data, '{lifecycle}', '"drafting"'::jsonb) WHERE data->>'lifecycle' = 'proposed';
UPDATE ideas                     SET data = jsonb_set(data, '{lifecycle}', '"drafting"'::jsonb) WHERE data->>'lifecycle' = 'proposed';
UPDATE reference_entities        SET data = jsonb_set(data, '{lifecycle}', '"drafting"'::jsonb) WHERE data->>'lifecycle' = 'proposed';

UPDATE principals                SET data = jsonb_set(data, '{lifecycle}', '"asserted"'::jsonb) WHERE data->>'lifecycle' = 'accepted';
UPDATE intents                   SET data = jsonb_set(data, '{lifecycle}', '"asserted"'::jsonb) WHERE data->>'lifecycle' = 'accepted';
UPDATE decisions                 SET data = jsonb_set(data, '{lifecycle}', '"asserted"'::jsonb) WHERE data->>'lifecycle' = 'accepted';
UPDATE rules                     SET data = jsonb_set(data, '{lifecycle}', '"asserted"'::jsonb) WHERE data->>'lifecycle' = 'accepted';
UPDATE guidance_policies         SET data = jsonb_set(data, '{lifecycle}', '"asserted"'::jsonb) WHERE data->>'lifecycle' = 'accepted';
UPDATE neuron_authoring_policies SET data = jsonb_set(data, '{lifecycle}', '"asserted"'::jsonb) WHERE data->>'lifecycle' = 'accepted';
UPDATE actions                   SET data = jsonb_set(data, '{lifecycle}', '"asserted"'::jsonb) WHERE data->>'lifecycle' = 'accepted';
UPDATE logs                      SET data = jsonb_set(data, '{lifecycle}', '"asserted"'::jsonb) WHERE data->>'lifecycle' = 'accepted';
UPDATE evals                     SET data = jsonb_set(data, '{lifecycle}', '"asserted"'::jsonb) WHERE data->>'lifecycle' = 'accepted';
UPDATE states                    SET data = jsonb_set(data, '{lifecycle}', '"asserted"'::jsonb) WHERE data->>'lifecycle' = 'accepted';
UPDATE ideas                     SET data = jsonb_set(data, '{lifecycle}', '"asserted"'::jsonb) WHERE data->>'lifecycle' = 'accepted';
UPDATE reference_entities        SET data = jsonb_set(data, '{lifecycle}', '"asserted"'::jsonb) WHERE data->>'lifecycle' = 'accepted';

-- 5. Per-Doco default lifecycle for new captures.
UPDATE docos SET default_neuron_lifecycle = 'drafting' WHERE default_neuron_lifecycle = 'proposed';
UPDATE docos SET default_neuron_lifecycle = 'asserted' WHERE default_neuron_lifecycle = 'accepted';

-- 6. Perspective config: the target lifecycle the (formerly "approve")
--    button transitions a neuron to, plus any source lifecycle filter.
UPDATE perspectives
   SET config = jsonb_set(config, '{approve_lifecycle}', '"asserted"'::jsonb)
 WHERE config->>'approve_lifecycle' = 'accepted';
UPDATE perspectives
   SET config = jsonb_set(config, '{approve_lifecycle}', '"drafting"'::jsonb)
 WHERE config->>'approve_lifecycle' = 'proposed';

-- 7. Policy `fires_when_neuron_lifecycle` arrays (string arrays stored
--    in the `data` jsonb of authoring/guidance policies). Rebuild each
--    array, mapping 'proposed' -> 'drafting' and 'accepted' ->
--    'asserted', de-duplicating so a {proposed, drafting} pair does not
--    yield two 'drafting' elements. Guarded so only rows whose array
--    actually contains a retired value are touched.
UPDATE neuron_authoring_policies p
   SET data = jsonb_set(
         p.data,
         '{fires_when_neuron_lifecycle}',
         (
           SELECT jsonb_agg(DISTINCT mapped)
           FROM (
             SELECT CASE
                      WHEN elem = 'proposed' THEN 'drafting'
                      WHEN elem = 'accepted' THEN 'asserted'
                      ELSE elem
                    END AS mapped
             FROM jsonb_array_elements_text(p.data->'fires_when_neuron_lifecycle') AS elem
           ) m
         )
       )
 WHERE jsonb_typeof(p.data->'fires_when_neuron_lifecycle') = 'array'
   AND (p.data->'fires_when_neuron_lifecycle' ? 'proposed'
        OR p.data->'fires_when_neuron_lifecycle' ? 'accepted');

UPDATE guidance_policies p
   SET data = jsonb_set(
         p.data,
         '{fires_when_neuron_lifecycle}',
         (
           SELECT jsonb_agg(DISTINCT mapped)
           FROM (
             SELECT CASE
                      WHEN elem = 'proposed' THEN 'drafting'
                      WHEN elem = 'accepted' THEN 'asserted'
                      ELSE elem
                    END AS mapped
             FROM jsonb_array_elements_text(p.data->'fires_when_neuron_lifecycle') AS elem
           ) m
         )
       )
 WHERE jsonb_typeof(p.data->'fires_when_neuron_lifecycle') = 'array'
   AND (p.data->'fires_when_neuron_lifecycle' ? 'proposed'
        OR p.data->'fires_when_neuron_lifecycle' ? 'accepted');
