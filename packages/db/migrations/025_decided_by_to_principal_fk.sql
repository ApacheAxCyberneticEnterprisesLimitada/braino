-- 025_decided_by_to_principal_fk.sql
-- ============================================================
-- Aligns the `decisions.decided_by` FK with the capture API contract.
--
-- Background. Migration 013 promoted `data->>'decided_by'` to a real
-- column and added a FK to `collaborators(id)`. The intent at the
-- time was that Decisions referenced an OAuth identity. Post-rename,
-- the project moved to treat `decided_by` as a Principal id: PR #66
-- made the capture endpoint reject collaborator ids and require
-- principal ids only.
--
-- The schema constraint was never updated to match. Every Decision
-- captured via the JSON API surfaced as HTTP 500 once the predicate
-- gates passed — the INSERT failed the FK because `decided_by`
-- carried a `principal_<ulid>` value that has no row in
-- `collaborators`.
--
-- Hotfix shape: drop the wrong FK. We deliberately do NOT add a new
-- FK to `principals(id)` in this migration — an earlier version of
-- this file tried to backfill + swap + VALIDATE, but failed in
-- production (every request 500'd while ensureSchema retried the
-- failing migration), so the migration is reduced to the one step
-- that's safely repeatable: drop the constraint that's actively
-- breaking captures. A follow-up migration can add the principals FK
-- back once we've inspected the data with full safety.
--
-- Also reverts the user-flows decided_by prose that PR #120
-- (migration 024) flipped from "principal" → "collaborator" — once
-- the FK no longer pretends decided_by is a collaborator, the older
-- "principal" wording is again accurate.
-- ============================================================

ALTER TABLE decisions DROP CONSTRAINT IF EXISTS decisions_decided_by_fk;

UPDATE neuron_authoring_primitives
   SET data = jsonb_set(
                data,
                '{summary}',
                to_jsonb(
                  'Every Decision in user-flows must declare the principal who owns the branch or choice in the `decided_by` field.'::text
                )
              ),
       summary = 'Every Decision in user-flows must declare the principal who owns the branch or choice in the `decided_by` field.',
       updated_at = now()
 WHERE data->>'template_handle' = 'user-flows'
   AND summary = 'Every Decision in user-flows must declare the collaborator who owns the branch or choice in the `decided_by` field.';
