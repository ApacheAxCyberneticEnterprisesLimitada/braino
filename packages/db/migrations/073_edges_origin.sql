-- 073_edges_origin.sql — mark how each edge came to exist, for the
-- "edges as the authored source of truth" refactor (option (i)).
--
-- 'authored' = created directly via the edges API (captureEdge), with its own
-- provenance/history. 'field' = projected by the capture path from a node
-- relationship field (e.g. a Decision's decided_by) and reconciled on every
-- re-capture of that node. Only 'field' edges are reconciled; 'authored' edges
-- are never auto-retired.
--
-- Every edge that predates this column was authored directly, so the column
-- defaults to 'authored'. That default is a constant, so PG 11+ adds the column
-- without rewriting the table. The CHECK is added NOT VALID — the migration-025
-- lesson is to never scan existing rows at boot; a later operator-run
-- `VALIDATE CONSTRAINT edges_origin_chk` can promote it (existing rows are all
-- 'authored', so the scan would pass).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + a pg_constraint guard on the CHECK.
-- Guarded on edges existence (a fresh genesis bootstrap drops the table between
-- the two schema.sql passes — see migration 064's note — so this is a no-op
-- there and the inline column in schema.sql applies instead).

DO $do$
BEGIN
  IF to_regclass('public.edges') IS NOT NULL THEN
    ALTER TABLE edges ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'authored';

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edges_origin_chk') THEN
      ALTER TABLE edges ADD CONSTRAINT edges_origin_chk
        CHECK (origin IN ('authored','field')) NOT VALID;
    END IF;
  ELSE
    RAISE NOTICE '073: edges table absent (fresh genesis bootstrap) — schema.sql inline column applies instead';
  END IF;
END
$do$;
