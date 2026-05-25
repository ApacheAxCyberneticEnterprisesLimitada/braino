-- 036_retemplate_after_principal_slim_down.sql
-- ============================================================
-- Backports the template changes from the Principal slim-down
-- (Step A of the neuron shape sweep) to already-deployed Docos.
-- After the slim-down, Principal carries only `name` + `body_md`;
-- the `display_name`, `description`, and `type` keys are gone.
-- The `org-chart` template's policies were rewritten in
-- packages/host/src/doco-templates.ts to match — this migration
-- rewrites the *captured* policy rows in every Doco that was
-- seeded from the old template shape so they line up with the
-- new template.
--
-- Pattern matches the existing `024_refresh_template_primitives`
-- and `026_retemplate_summary_gaps` migrations: gate each UPDATE
-- on a fingerprint of the old captured shape so maintainer hand-
-- edits stay untouched.
--
-- Three changes:
--   1. org-chart `requires_field: ["type"]` policy → probabilistic
--      body_md check.
--   2. org-chart `display_name` style gate → `name` slug gate.
--   3. org-chart guidance about "flipping `type` in place" →
--      updated wording about body_md prose.

BEGIN;

-- ── 1. requires_field type → probabilistic body_md check ────────
-- Old shape: predicate.kind = 'requires_field', predicate.fields = ['type'],
--            predicate.when_neuron_type = ['principal']
-- New shape: predicate.kind = 'probabilistic', predicate.spec reads body_md
UPDATE neuron_authoring_policies
   SET data = jsonb_set(
                jsonb_set(
                  jsonb_set(
                    data,
                    '{predicate}',
                    jsonb_build_object(
                      'kind', 'probabilistic',
                      'when_neuron_type', jsonb_build_array('principal'),
                      'spec',
                      'Read the Principal''s `body_md`. PASS if the prose clearly states the role is filled by a human person (e.g. ''Human director of …'', ''Person responsible for …'') OR by an AI agent (e.g. ''AI agent operated by @alice'', ''Autonomous research bot''). FAIL with a reason if `body_md` is empty or doesn''t take a stance on person-vs-agent.'
                    )
                  ),
                  '{summary}',
                  to_jsonb(
                    'Every Principal in an org chart must declare whether it''s a person or an AI agent in its `body_md` prose. The org-tree perspective infers the distinction from the prose; without an explicit declaration a chart can''t tell humans from AI agents.'::text
                  )
                ),
                '{evaluation_kind}',
                '"probabilistic"'::jsonb
              ),
       summary = 'Every Principal in an org chart must declare whether it''s a person or an AI agent in its `body_md` prose. The org-tree perspective infers the distinction from the prose; without an explicit declaration a chart can''t tell humans from AI agents.',
       updated_at = now()
 WHERE data->>'template_handle' = 'org-chart'
   AND data->'predicate'->>'kind' = 'requires_field'
   AND data->'predicate'->'fields' = '["type"]'::jsonb;

-- ── 2. display_name style gate → name slug gate ─────────────────
-- The probabilistic gate used to read the Principal's `display_name`
-- field; after the slim-down it reads the `name` slug.
UPDATE neuron_authoring_policies
   SET data = jsonb_set(
                jsonb_set(
                  data,
                  '{predicate,spec}',
                  to_jsonb(
                    'Check ONLY the Principal''s `name` slug. PASS when it reads as a role, title, position, or team name (`coo`, `engineering-lead`, `code-review-agent`, `kitchen`, `customer-success`). FAIL with reason if it reads as a verb naming an action (`approve-budget`, `review-code`), or as a serial / placeholder label (`person-1`, `member-a`, `tbd`, `unassigned`).'::text
                  )
                ),
                '{summary}',
                to_jsonb(
                  'Principal `name` reads as a role, title, or team name slug — `coo`, `engineering-lead`, `code-review-agent`, `kitchen` — not a verb (`approve-budget`) or a serial label (`person-1`, `member-a`, `tbd`).'::text
                )
              ),
       summary = 'Principal `name` reads as a role, title, or team name slug — `coo`, `engineering-lead`, `code-review-agent`, `kitchen` — not a verb (`approve-budget`) or a serial label (`person-1`, `member-a`, `tbd`).',
       updated_at = now()
 WHERE data->>'template_handle' = 'org-chart'
   AND data->'predicate'->>'kind' = 'probabilistic'
   -- `->>` (text extraction) so LIKE operates on text, not jsonb. The
   -- first version of this migration used `->` (jsonb extraction) here
   -- and Postgres rejected the `LIKE` operator with type jsonb, taking
   -- prod down on every cold start until this fix landed.
   AND data->'predicate'->>'spec' LIKE '%display_name%';

-- ── 3. guidance: "flipping type in place" → body_md prose ──────
UPDATE guidance_policies
   SET data = jsonb_set(
                data,
                '{summary}',
                to_jsonb(
                  'When an AI-agent role is replaced by a human (or vice-versa), retire the old Principal and create a new one with `body_md` describing the new occupant. Person-vs-agent is part of the role''s identity in this Doco — flipping it via a body_md edit on the same Principal erases the history of the seat''s prior occupant.'::text
                )
              ),
       summary = 'When an AI-agent role is replaced by a human (or vice-versa), retire the old Principal and create a new one with `body_md` describing the new occupant. Person-vs-agent is part of the role''s identity in this Doco — flipping it via a body_md edit on the same Principal erases the history of the seat''s prior occupant.',
       updated_at = now()
 WHERE data->>'template_handle' = 'org-chart'
   AND summary LIKE '%retire the old Principal and create a new one with the new `type`%';

-- ── 4. guidance: "Principal type: agent / type: person" prose ──
UPDATE guidance_policies
   SET data = jsonb_set(
                data,
                '{summary}',
                to_jsonb(
                  'Person vs agent isn''t about who signed in — it''s about who fills the seat. A Principal whose `body_md` describes an AI agent (a code reviewer, a triage bot, a research agent) is an agent regardless of whether any Collaborator has signed in as it. A Principal whose `body_md` describes a human is a person, even if that human has no Doco account.'::text
                )
              ),
       summary = 'Person vs agent isn''t about who signed in — it''s about who fills the seat. A Principal whose `body_md` describes an AI agent (a code reviewer, a triage bot, a research agent) is an agent regardless of whether any Collaborator has signed in as it. A Principal whose `body_md` describes a human is a person, even if that human has no Doco account.',
       updated_at = now()
 WHERE data->>'template_handle' = 'org-chart'
   AND summary LIKE '%A Principal `type: agent` means%';

COMMIT;
