-- 037_principal_drop_summary.sql
-- ============================================================
-- Finishes the Principal slim-down: the `summary` column on
-- `principals` is the last legacy "one-line readable label"
-- that survived. Per the user's "name + body_md only"
-- instruction, kill it.
--
-- Salvage anything in `summary` that *isn't* already trivially
-- restateable (i.e. that isn't just a repetition of `name`) into
-- the head of `body_md` so no information is lost. The principals
-- POST route currently defaults `summary` to the name when nothing
-- else is supplied, so those rows have no real content to salvage.
--
-- After this:
--   * The other 9 neuron types continue to carry NO `summary`
--     column (migration 023 collapsed it into the type-named
--     prose column).
--   * Policies still carry `summary` because for a policy `summary`
--     IS the rule statement, not a redundant one-liner.
--   * Principal carries `name` (immutable slug) + `body_md`
--     (everything else) — matching the slim-down intent.

BEGIN;

-- Salvage non-trivial summaries into body_md so prior intent isn't
-- lost. "Trivial" = the summary is just the name slug or one of the
-- reserved-role-principal default sentences the POST route writes
-- for `user` / `human` / `doco-host` / `github`. Those carry no
-- information beyond what `name` + `role_principal` already convey.
UPDATE principals
   SET body_md =
       NULLIF(
         CONCAT_WS(
           E'\n\n',
           NULLIF(TRIM(BOTH FROM summary), ''),
           NULLIF(body_md, '')
         ),
         ''
       )
 WHERE summary IS NOT NULL
   AND TRIM(BOTH FROM summary) <> ''
   AND LOWER(TRIM(BOTH FROM summary)) <> LOWER(name)
   AND summary NOT IN (
     'Role principal for any Doco user, whether person or AI agent.',
     'Role principal for the person-only subset of users.',
     'System principal for the Doco host service.',
     'External identity-provider principal for GitHub.'
   );

ALTER TABLE principals DROP COLUMN IF EXISTS summary;

COMMIT;
