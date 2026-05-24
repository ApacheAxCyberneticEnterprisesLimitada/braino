-- 025_decided_by_to_principal_fk.sql
-- ============================================================
-- Aligns the `decisions.decided_by` FK with the capture API contract.
--
-- Background. Migration 013 promoted `data->>'decided_by'` to a real
-- column and added a FK to `collaborators(id)`. The intent at the time
-- was that Decisions referenced an OAuth identity (the collaborator
-- who made the call). Post-rename, the project moved to treat
-- `decided_by` as a Principal id (role-persona), matching the
-- capture-API contract: PR #66 made the capture endpoint reject
-- collaborator ids in `decided_by_principal_id` and require principal
-- ids only.
--
-- The schema constraint was never updated to match. Today every
-- attempt to capture a Decision via the JSON API surfaces as HTTP 500
-- once the predicate gates pass — the INSERT fails the FK because
-- `decided_by` carries a `principal_<ulid>` value that has no row in
-- `collaborators`. Surfaced during BPMN-phase-1-to-4 verification on
-- production.
--
-- Fix:
--   1. Backfill any existing `decided_by` row holding a collaborator
--      id (pre-rename data) by looking up the collaborator's
--      github_login and resolving to a matching principal in the same
--      Doco. Rows that don't resolve are NULL'd — Decision is still
--      readable; the audit history of who decided it lives in the
--      audit_events table.
--   2. Drop the old `decisions_decided_by_fk` (REFERENCES collaborators).
--   3. Add the new `decisions_decided_by_principal_fk` REFERENCES
--      principals(id) ON DELETE SET NULL. Matches the capture-API
--      contract going forward.
-- ============================================================

-- 1) Backfill: collaborator_* → matching principal (by lowercase
-- github_login = principal.name) within the same Doco. Two-step:
-- first the rows with a clean match get the principal id; then any
-- remaining collaborator_* rows are NULL'd so the new FK validates.

UPDATE decisions d
   SET decided_by = p.id
  FROM collaborators c
  JOIN principals p
    ON LOWER(p.name) = LOWER(c.github_login)
   AND p.doco_id = d.doco_id
 WHERE d.decided_by = c.id
   AND d.decided_by LIKE 'collaborator_%';

UPDATE decisions
   SET decided_by = NULL
 WHERE decided_by LIKE 'collaborator_%';

-- 2) Drop the old FK (REFERENCES collaborators).
ALTER TABLE decisions DROP CONSTRAINT IF EXISTS decisions_decided_by_fk;

-- 3) Add the new FK (REFERENCES principals). NOT VALID + VALIDATE
-- mirrors 013's pattern: avoids a long lock during DDL on a busy
-- table, then validates as a separate (lighter) step.
ALTER TABLE decisions
  ADD CONSTRAINT decisions_decided_by_principal_fk
  FOREIGN KEY (decided_by) REFERENCES principals(id) ON DELETE SET NULL
  NOT VALID;
ALTER TABLE decisions VALIDATE CONSTRAINT decisions_decided_by_principal_fk;

-- ============================================================
-- Revert the user-flows decided_by prose from "collaborator" back to
-- "principal". Migration 024 (PR #120) flipped it to "collaborator"
-- on the mistaken assumption that decided_by referenced the OAuth
-- identity. With the FK now pointing at principals (above), the
-- principal wording is once again accurate. Idempotent: matches the
-- exact 024 wording, so author-customized rows stay untouched.
-- ============================================================

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
