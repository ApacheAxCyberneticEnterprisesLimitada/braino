-- 079_simplify_edge_types_reset.sql - simplified edge vocabulary reset (FULL WIPE).
--
-- Doco is still testing the waters with the graph model, and the 20-relation
-- vocabulary had too much overlap. This reset dumps all existing production
-- and test Docos so the next schema bookend recreates an empty database with
-- the smaller canonical edge families.
--
-- Preserve applied_migrations only: the runner records this migration in the
-- same forward-only ledger, then schema.sql runs again and rebuilds the
-- baseline tables from scratch.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT tablename
      FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> 'applied_migrations'
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.tablename);
  END LOOP;
END $$;
