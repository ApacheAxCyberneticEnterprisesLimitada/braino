-- 034_drop_neuron_slugs.sql
-- ============================================================
-- Per "remove slugs from all neurons" (this PR): the `slug` key
-- that lived inside the `data` jsonb on every capture-capable
-- neuron table goes away. No code ever read it back (the field
-- was write-only — historically captured by routes that whitelisted
-- it, never displayed in any perspective), so dropping it is
-- lossless beyond the historical metadata itself. Principal's
-- `name` column is unchanged; it was always the lookup slug for
-- Principals specifically and stays so per the slim-down.
--
-- One UPDATE per table to keep the WHERE-clause planning trivial.
-- Idempotent: the `data ? 'slug'` predicate filters to rows that
-- still carry the key.

BEGIN;

UPDATE intents            SET data = data - 'slug' WHERE data ? 'slug';
UPDATE decisions          SET data = data - 'slug' WHERE data ? 'slug';
UPDATE rules              SET data = data - 'slug' WHERE data ? 'slug';
UPDATE actions            SET data = data - 'slug' WHERE data ? 'slug';
UPDATE logs               SET data = data - 'slug' WHERE data ? 'slug';
UPDATE evals              SET data = data - 'slug' WHERE data ? 'slug';
UPDATE states             SET data = data - 'slug' WHERE data ? 'slug';
UPDATE ideas              SET data = data - 'slug' WHERE data ? 'slug';
UPDATE reference_entities SET data = data - 'slug' WHERE data ? 'slug';
UPDATE principals         SET data = data - 'slug' WHERE data ? 'slug';

COMMIT;
