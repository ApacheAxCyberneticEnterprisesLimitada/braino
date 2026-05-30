-- 040_relax_principal_name.sql
-- ============================================================
-- Principal.name is now a descriptive display label, not a Doco-scoped
-- slug key. Other neurons reference Principals by id, so duplicate and
-- non-slug-shaped names are valid.

BEGIN;

ALTER TABLE principals
  DROP CONSTRAINT IF EXISTS principals_doco_name_key;

UPDATE neuron_authoring_policies
   SET lifecycle = 'retired',
       data = jsonb_set(data, '{lifecycle}', '"retired"'::jsonb, true),
       updated_at = now()
 WHERE data->>'template_handle' = 'org-chart'
   AND data->'predicate'->>'kind' = 'probabilistic'
   AND (
     policy = 'Principal `name` reads as a role, title, or team name slug — `coo`, `engineering-lead`, `code-review-agent`, `kitchen` — not a verb (`approve-budget`) or a serial label (`person-1`, `member-a`, `tbd`).'
     OR data->'predicate'->>'spec' LIKE '%Principal''s `name` slug%'
   );

COMMIT;
