-- 025_retemplate_orphan_transition.sql
-- ============================================================
-- Follow-up to 024. The state-machines `P-orphan-transition`
-- primitive was missed in 024's sweep: its old wording referred to
-- "(the body explains why it fires unconditionally)" and "firing in
-- the body" — the body_md column is gone for Actions after migration
-- 023, so the prose now points at the `action` field.
--
-- The template (packages/host/src/doco-templates.ts) was updated as
-- part of PR #113; this migration brings primitives already seeded
-- into prod Docos in line.
-- ============================================================


-- Guard: skip when the legacy `neuron_authoring_primitives` /
-- `guidance_primitives` tables no longer exist (post-028 rename).
DO $migration_guard$ BEGIN
IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name IN ('neuron_authoring_primitives', 'guidance_primitives')) THEN
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(
                jsonb_set(data,
                  '{summary}',
                  to_jsonb('A transition Action with empty `triggered_by` AND empty `gated_by` is either an explicit immediate transition (the `action` field explains why it fires unconditionally) or an authoring oversight — capture the intent.'::text)
                ),
                '{predicate,spec}',
                to_jsonb('A transition Action with empty triggered_by AND empty gated_by either explicitly justifies its unconditional firing in the `action` field, or is an authoring oversight to flag.'::text)
              ),
       summary = 'A transition Action with empty `triggered_by` AND empty `gated_by` is either an explicit immediate transition (the `action` field explains why it fires unconditionally) or an authoring oversight — capture the intent.',
       updated_at = now()
 WHERE data->>'template_handle' = 'state-machines'
   AND summary LIKE '%(the body explains why it fires unconditionally)%';

END IF;
END $migration_guard$;
