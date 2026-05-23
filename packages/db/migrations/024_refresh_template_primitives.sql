-- 024_refresh_template_primitives.sql
-- ============================================================
-- Refresh template primitives that drifted from their source after
-- the post-rename vocab sweep (Principal/Collaborator split,
-- type-named neuron prose columns).
--
-- Two hard breaks (deterministic predicates that fail every neuron
-- of the gated type until updated):
--
--   1. user-flows: `requires_field fields=["wanted_by"]` on intent.
--      Intent has no `wanted_by` field — it was renamed to `actors`
--      in the Principal/Collaborator split (entities.ts:158-170).
--      Predicate blocks every active Intent.
--
--   2. test: `requires_field fields=["name", "criterion"]` on eval.
--      Eval has no `name` field — the type-named column `eval`
--      replaced `name` + `description` + `summary` in 022/023.
--      Predicate blocks every Eval.
--
-- Two prose corrections (predicate runs but the operator-facing
-- message says the wrong thing):
--
--   3. user-flows: Decision.decided_by message calls it a principal —
--      it's a Collaborator post-rename (entities.ts:290).
--
--   4. user-flows + business-processes: actor_id resolver primitive
--      claims the principal must be `person` or `agent` — the engine
--      no longer enforces that (the person/agent split moved to
--      Collaborator; see entities.ts:236-242).
--
-- Match key: `template_handle` + a unique fingerprint (old predicate
-- fields, or full old summary text). Mirrors 018's approach. If a
-- maintainer hand-edited the summary the WHERE clause won't match
-- and their customization stays.
-- ============================================================

-- 1) user-flows: wanted_by → actors  (HARD BREAK)
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(
                jsonb_set(
                  data,
                  '{predicate,fields}',
                  '["actors"]'::jsonb
                ),
                '{summary}',
                to_jsonb(
                  'Every Intent in user-flows must declare the principals who want the journey in the `actors` field.'::text
                )
              ),
       summary = 'Every Intent in user-flows must declare the principals who want the journey in the `actors` field.',
       updated_at = now()
 WHERE data->>'template_handle' = 'user-flows'
   AND data->'predicate'->>'kind' = 'requires_field'
   AND data->'predicate'->'fields' = '["wanted_by"]'::jsonb;

-- 2) test: name → eval  (HARD BREAK)
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(
                jsonb_set(
                  data,
                  '{predicate,fields}',
                  '["eval", "criterion"]'::jsonb
                ),
                '{summary}',
                to_jsonb(
                  'Every Eval declares what it is and how it''s graded — `eval` and `criterion` are required from creation.'::text
                )
              ),
       summary = 'Every Eval declares what it is and how it''s graded — `eval` and `criterion` are required from creation.',
       updated_at = now()
 WHERE data->>'template_handle' = 'test'
   AND data->'predicate'->>'kind' = 'requires_field'
   AND data->'predicate'->'fields' = '["name", "criterion"]'::jsonb;

-- 3) user-flows: Decision decided_by prose — principal → collaborator
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(
                data,
                '{summary}',
                to_jsonb(
                  'Every Decision in user-flows must declare the collaborator who owns the branch or choice in the `decided_by` field.'::text
                )
              ),
       summary = 'Every Decision in user-flows must declare the collaborator who owns the branch or choice in the `decided_by` field.',
       updated_at = now()
 WHERE data->>'template_handle' = 'user-flows'
   AND summary = 'Every Decision in user-flows must declare the principal who owns the branch or choice in the `decided_by` field.';

-- 4a) user-flows: drop "type is person or agent" qualifier on actor_id resolver
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(
                data,
                '{summary}',
                to_jsonb(
                  'An Action''s `actor_id` must resolve to an existing Principal. System-internal steps (the browser, a background job, a script) belong in `apis` or `adrs`, not in a user-flow.'::text
                )
              ),
       summary = 'An Action''s `actor_id` must resolve to an existing Principal. System-internal steps (the browser, a background job, a script) belong in `apis` or `adrs`, not in a user-flow.',
       updated_at = now()
 WHERE data->>'template_handle' = 'user-flows'
   AND summary = 'An Action''s `actor_id` must resolve to an existing Principal whose type is `person` or `agent`. System-internal steps (the browser, a background job, a script) belong in `apis` or `adrs`, not in a user-flow.';

-- 4b) business-processes: same drop on its actor_id resolver
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(
                data,
                '{summary}',
                to_jsonb(
                  'An Action''s `actor_id` must resolve to an existing Principal. Team-roles (e.g. `kitchen`, `support`, `finance`) are first-class Principals — model them as Principals representing a role rather than an individual.'::text
                )
              ),
       summary = 'An Action''s `actor_id` must resolve to an existing Principal. Team-roles (e.g. `kitchen`, `support`, `finance`) are first-class Principals — model them as Principals representing a role rather than an individual.',
       updated_at = now()
 WHERE data->>'template_handle' = 'business-processes'
   AND summary = 'An Action''s `actor_id` must resolve to an existing Principal whose type is `person` or `agent`. Team-roles (e.g. `kitchen`, `support`, `finance`) are first-class Principals — model them as Principals representing a role rather than an individual.';
