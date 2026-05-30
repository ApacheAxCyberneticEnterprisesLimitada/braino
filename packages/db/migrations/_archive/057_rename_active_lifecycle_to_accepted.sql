-- 057_rename_active_lifecycle_to_accepted.sql
-- ============================================================
-- Renames the neuron lifecycle value 'active' -> 'accepted'.
--
-- The lifecycle column expresses approval status:
--   drafting -> proposed -> accepted -> retired
-- Only 'active' is renamed to 'accepted'; the other three stages are
-- untouched. The application keeps a back-compat input alias for one
-- release (normalizeLifecycle coerces an incoming "active" to
-- "accepted"), so existing API clients/agents do not break while data
-- is migrated.
--
-- Lifecycle is stored in two places per neuron/policy row: the typed
-- `lifecycle` text column AND a mirror inside the denormalized `data`
-- jsonb bag (capture.server.ts writes `data: fm` where fm carries
-- lifecycle, plus the typed column). Both are rewritten here.
--
-- The runner wraps each migration in a single BEGIN/COMMIT and records
-- it in applied_migrations, so this file omits transaction control and
-- bookkeeping. Every statement is guarded by a WHERE on the old value,
-- making the migration idempotent and safe to re-run.
-- ============================================================

-- 1. Typed lifecycle column on the 12 neuron/policy tables.
UPDATE principals                SET lifecycle = 'accepted' WHERE lifecycle = 'active';
UPDATE intents                   SET lifecycle = 'accepted' WHERE lifecycle = 'active';
UPDATE decisions                 SET lifecycle = 'accepted' WHERE lifecycle = 'active';
UPDATE rules                     SET lifecycle = 'accepted' WHERE lifecycle = 'active';
UPDATE guidance_policies         SET lifecycle = 'accepted' WHERE lifecycle = 'active';
UPDATE neuron_authoring_policies SET lifecycle = 'accepted' WHERE lifecycle = 'active';
UPDATE actions                   SET lifecycle = 'accepted' WHERE lifecycle = 'active';
UPDATE logs                      SET lifecycle = 'accepted' WHERE lifecycle = 'active';
UPDATE evals                     SET lifecycle = 'accepted' WHERE lifecycle = 'active';
UPDATE states                    SET lifecycle = 'accepted' WHERE lifecycle = 'active';
UPDATE ideas                     SET lifecycle = 'accepted' WHERE lifecycle = 'active';
UPDATE reference_entities        SET lifecycle = 'accepted' WHERE lifecycle = 'active';

-- 2. The lifecycle mirror inside each row's `data` jsonb bag.
UPDATE principals                SET data = jsonb_set(data, '{lifecycle}', '"accepted"'::jsonb) WHERE data->>'lifecycle' = 'active';
UPDATE intents                   SET data = jsonb_set(data, '{lifecycle}', '"accepted"'::jsonb) WHERE data->>'lifecycle' = 'active';
UPDATE decisions                 SET data = jsonb_set(data, '{lifecycle}', '"accepted"'::jsonb) WHERE data->>'lifecycle' = 'active';
UPDATE rules                     SET data = jsonb_set(data, '{lifecycle}', '"accepted"'::jsonb) WHERE data->>'lifecycle' = 'active';
UPDATE guidance_policies         SET data = jsonb_set(data, '{lifecycle}', '"accepted"'::jsonb) WHERE data->>'lifecycle' = 'active';
UPDATE neuron_authoring_policies SET data = jsonb_set(data, '{lifecycle}', '"accepted"'::jsonb) WHERE data->>'lifecycle' = 'active';
UPDATE actions                   SET data = jsonb_set(data, '{lifecycle}', '"accepted"'::jsonb) WHERE data->>'lifecycle' = 'active';
UPDATE logs                      SET data = jsonb_set(data, '{lifecycle}', '"accepted"'::jsonb) WHERE data->>'lifecycle' = 'active';
UPDATE evals                     SET data = jsonb_set(data, '{lifecycle}', '"accepted"'::jsonb) WHERE data->>'lifecycle' = 'active';
UPDATE states                    SET data = jsonb_set(data, '{lifecycle}', '"accepted"'::jsonb) WHERE data->>'lifecycle' = 'active';
UPDATE ideas                     SET data = jsonb_set(data, '{lifecycle}', '"accepted"'::jsonb) WHERE data->>'lifecycle' = 'active';
UPDATE reference_entities        SET data = jsonb_set(data, '{lifecycle}', '"accepted"'::jsonb) WHERE data->>'lifecycle' = 'active';

-- 3. Per-Doco default lifecycle for new captures.
UPDATE docos SET default_neuron_lifecycle = 'accepted' WHERE default_neuron_lifecycle = 'active';

-- 4. Approval perspective config: the target lifecycle the approve
--    button transitions a neuron to.
UPDATE perspectives
   SET config = jsonb_set(config, '{approve_lifecycle}', '"accepted"'::jsonb)
 WHERE config->>'approve_lifecycle' = 'active';

-- 5. Policy `fires_when_neuron_lifecycle` arrays (string arrays stored
--    in the `data` jsonb of authoring/guidance policies). Rebuild the
--    array element-by-element, mapping 'active' -> 'accepted' and
--    leaving every other element intact. Guarded so only rows whose
--    array actually contains 'active' are touched.
UPDATE neuron_authoring_policies p
   SET data = jsonb_set(
         p.data,
         '{fires_when_neuron_lifecycle}',
         (
           SELECT jsonb_agg(
             CASE WHEN elem = 'active' THEN 'accepted' ELSE elem END
           )
           FROM jsonb_array_elements_text(p.data->'fires_when_neuron_lifecycle') AS elem
         )
       )
 WHERE jsonb_typeof(p.data->'fires_when_neuron_lifecycle') = 'array'
   AND p.data->'fires_when_neuron_lifecycle' ? 'active';

UPDATE guidance_policies p
   SET data = jsonb_set(
         p.data,
         '{fires_when_neuron_lifecycle}',
         (
           SELECT jsonb_agg(
             CASE WHEN elem = 'active' THEN 'accepted' ELSE elem END
           )
           FROM jsonb_array_elements_text(p.data->'fires_when_neuron_lifecycle') AS elem
         )
       )
 WHERE jsonb_typeof(p.data->'fires_when_neuron_lifecycle') = 'array'
   AND p.data->'fires_when_neuron_lifecycle' ? 'active';

-- 6. Audit history. before_json / after_json store a partial entity
--    snapshot with lifecycle at the top level (audit-log.server.ts
--    writes event.before / event.after verbatim; capture.server.ts
--    builds { lifecycle: ... } among other fields). Rewrite only the
--    top-level lifecycle key when it holds the old value.
UPDATE audit_events
   SET before_json = jsonb_set(before_json, '{lifecycle}', '"accepted"'::jsonb)
 WHERE before_json->>'lifecycle' = 'active';

UPDATE audit_events
   SET after_json = jsonb_set(after_json, '{lifecycle}', '"accepted"'::jsonb)
 WHERE after_json->>'lifecycle' = 'active';
