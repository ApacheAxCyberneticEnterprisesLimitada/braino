-- 063_genesis_reset.sql — doco-vnext GENESIS RESET (one-time, FULL WIPE).
--
-- The neuron→node / synapse→edge rename + first-class edges + append-only
-- history are a clean break with no back-compat (owner decision: FULL WIPE).
-- This migration retires the entire pre-vnext migration chain (archived under
-- migrations/_archive/) and resets every Doco to an empty graph on the new
-- schema.
--
-- Mechanism (see packages/db/src/client.ts applySchema bookend): drop every
-- table EXCEPT the migration ledger, then the baseline schema.sql is re-run
-- AFTER migrations (the second bookend pass) and recreates the new schema
-- empty. applied_migrations is preserved so prior ids stay recorded
-- (forward-only); this migration is itself recorded by the runner.
--
-- This is the ONE permitted destructive act. After it, append-only is law:
-- removal is `lifecycle='retired'`, never DELETE. (True row-level guardrails —
-- REVOKE UPDATE/DELETE on changesets/node_versions/edge_versions — require a
-- dedicated least-privilege app role; tracked in docs/plans/doco-vnext.md.
-- A REVOKE here is a no-op while the app connects as table owner/superuser.)

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> 'applied_migrations'
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.tablename);
  END LOOP;
END $$;
