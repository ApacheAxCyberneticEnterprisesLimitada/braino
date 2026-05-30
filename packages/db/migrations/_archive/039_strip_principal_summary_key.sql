-- 039_strip_principal_summary_key.sql
-- ============================================================
-- Migration 037 dropped the `summary` column on `principals` but
-- left `summary` keys living inside the `data` jsonb on every
-- row written before the column was dropped. The repo layer's
-- rowToRecord merges typed columns back into `rec.data` on read,
-- but it doesn't strip stale jsonb keys — so principals fetched
-- through the API surfaced `data.summary` even though the column
-- is gone. Per "kill summary on Principal, no back-compat", drop
-- the key from the jsonb too.
--
-- Idempotent: the `data ? 'summary'` predicate filters to rows
-- that still carry the key.

BEGIN;

UPDATE principals
   SET data = data - 'summary'
 WHERE data ? 'summary';

COMMIT;
