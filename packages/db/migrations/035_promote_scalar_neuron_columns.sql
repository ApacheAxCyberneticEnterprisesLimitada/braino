-- 035_promote_scalar_neuron_columns.sql
-- ============================================================
-- Step D of the neuron shape sweep. Per "jsonb should not be a
-- thing if it's important for us to keep in mind. It should have
-- an SQL column", promote the highest-impact *scalar* fields from
-- each neuron's `data` jsonb into typed columns. Compound fields
-- (predicate objects, intent_ids[] arrays, outputs blobs) stay as
-- jsonb on purpose: their value is the nested-structure
-- flexibility — promoting them would force a wider schema change
-- without buying query-side gains.
--
-- ── HOTFIX history ─────────────────────────────────────────────
-- The first version of this migration did the column ADDs AND the
-- data population in a single transaction, with strict
-- `::timestamptz` and `::boolean` casts on values pulled out of
-- `data` jsonb. A single malformed value anywhere in any of the
-- referenced tables rolled the whole txn back, leaving the new
-- columns un-added. Code on origin/main (repo.ts) then referenced
-- those non-existent columns on every DB hit, taking production
-- down with `ERROR: column "kind" does not exist`.
--
-- This rewrite splits the work into two phases:
--   1. Add the columns + indexes. Pure DDL, can't fail on data.
--   2. Populate the columns from the data jsonb, with stricter
--      regex guards that match only well-formed ISO timestamps
--      and the literal strings "true"/"false" — values that
--      definitely cast cleanly.
--
-- Each phase runs in its own transaction so a population failure
-- on one table doesn't unwind the column adds. The migration is
-- still idempotent — every gate guards on the new column still
-- being NULL.

-- ── Phase 1: column adds + indexes (DDL only, can't fail) ──────
BEGIN;

ALTER TABLE actions
  ADD COLUMN IF NOT EXISTS verb         text,
  ADD COLUMN IF NOT EXISTS performed_at timestamptz;
CREATE INDEX IF NOT EXISTS actions_verb_idx         ON actions (doco_id, verb);
CREATE INDEX IF NOT EXISTS actions_performed_at_idx ON actions (doco_id, performed_at DESC);

ALTER TABLE logs
  ADD COLUMN IF NOT EXISTS verb        text,
  ADD COLUMN IF NOT EXISTS happened_at timestamptz;
CREATE INDEX IF NOT EXISTS logs_verb_idx        ON logs (doco_id, verb);
CREATE INDEX IF NOT EXISTS logs_happened_at_idx ON logs (doco_id, happened_at DESC);

ALTER TABLE evals
  ADD COLUMN IF NOT EXISTS kind text;
CREATE INDEX IF NOT EXISTS evals_kind_idx ON evals (doco_id, kind);

ALTER TABLE rules
  ADD COLUMN IF NOT EXISTS kind         text,
  ADD COLUMN IF NOT EXISTS modality     text,
  ADD COLUMN IF NOT EXISTS severity     text,
  ADD COLUMN IF NOT EXISTS phase        text,
  ADD COLUMN IF NOT EXISTS on_violation text;
CREATE INDEX IF NOT EXISTS rules_kind_idx     ON rules (doco_id, kind);
CREATE INDEX IF NOT EXISTS rules_severity_idx ON rules (doco_id, severity);

ALTER TABLE states
  ADD COLUMN IF NOT EXISTS kind text;
CREATE INDEX IF NOT EXISTS states_kind_idx ON states (doco_id, kind);

ALTER TABLE reference_entities
  ADD COLUMN IF NOT EXISTS ref_type text,
  ADD COLUMN IF NOT EXISTS locator  text,
  ADD COLUMN IF NOT EXISTS citation text,
  ADD COLUMN IF NOT EXISTS title    text;
CREATE INDEX IF NOT EXISTS reference_entities_ref_type_idx
  ON reference_entities (doco_id, ref_type);

ALTER TABLE principals
  ADD COLUMN IF NOT EXISTS role_principal boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS principals_role_idx
  ON principals (doco_id) WHERE NOT role_principal;

COMMIT;

-- ── Phase 2: populate columns from data jsonb ──────────────────
-- Strict regexes prevent any cast from failing. Anything that
-- doesn't match stays as `NULL` on the typed column AND in the
-- jsonb until an operator fixes it manually. That's better than
-- rolling back the whole migration on one bad row.

-- Action.verb / Action.performed_at
BEGIN;

UPDATE actions
   SET verb = data->>'verb'
 WHERE verb IS NULL
   AND data ? 'verb'
   AND jsonb_typeof(data->'verb') = 'string';

UPDATE actions
   SET performed_at = (data->>'performed_at')::timestamptz
 WHERE performed_at IS NULL
   AND data ? 'performed_at'
   AND jsonb_typeof(data->'performed_at') = 'string'
   -- Match a full ISO 8601 instant: YYYY-MM-DDTHH:MM:SS optionally
   -- with fractional seconds and a timezone designator (Z or ±HH:MM).
   AND data->>'performed_at' ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$';

UPDATE actions
   SET data = data - 'verb' - 'performed_at'
 WHERE data ? 'verb' OR data ? 'performed_at';

COMMIT;

-- Log.verb / Log.happened_at
BEGIN;

UPDATE logs
   SET verb = data->>'verb'
 WHERE verb IS NULL
   AND data ? 'verb'
   AND jsonb_typeof(data->'verb') = 'string';

UPDATE logs
   SET happened_at = (data->>'happened_at')::timestamptz
 WHERE happened_at IS NULL
   AND data ? 'happened_at'
   AND jsonb_typeof(data->'happened_at') = 'string'
   AND data->>'happened_at' ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$';

UPDATE logs
   SET data = data - 'verb' - 'happened_at'
 WHERE data ? 'verb' OR data ? 'happened_at';

COMMIT;

-- Eval.kind
BEGIN;

UPDATE evals
   SET kind = data->>'kind'
 WHERE kind IS NULL
   AND data ? 'kind'
   AND jsonb_typeof(data->'kind') = 'string';

UPDATE evals
   SET data = data - 'kind'
 WHERE data ? 'kind';

COMMIT;

-- Rule.{kind,modality,severity,phase,on_violation}
BEGIN;

UPDATE rules
   SET kind         = CASE WHEN jsonb_typeof(data->'kind')         = 'string' THEN data->>'kind'         ELSE kind END,
       modality     = CASE WHEN jsonb_typeof(data->'modality')     = 'string' THEN data->>'modality'     ELSE modality END,
       severity     = CASE WHEN jsonb_typeof(data->'severity')     = 'string' THEN data->>'severity'     ELSE severity END,
       phase        = CASE WHEN jsonb_typeof(data->'phase')        = 'string' THEN data->>'phase'        ELSE phase END,
       on_violation = CASE WHEN jsonb_typeof(data->'on_violation') = 'string' THEN data->>'on_violation' ELSE on_violation END
 WHERE data ? 'kind' OR data ? 'modality' OR data ? 'severity' OR data ? 'phase' OR data ? 'on_violation';

UPDATE rules
   SET data = data - 'kind' - 'modality' - 'severity' - 'phase' - 'on_violation'
 WHERE data ? 'kind'
    OR data ? 'modality'
    OR data ? 'severity'
    OR data ? 'phase'
    OR data ? 'on_violation';

COMMIT;

-- State.kind
BEGIN;

UPDATE states
   SET kind = data->>'kind'
 WHERE kind IS NULL
   AND data ? 'kind'
   AND jsonb_typeof(data->'kind') = 'string';

UPDATE states
   SET data = data - 'kind'
 WHERE data ? 'kind';

COMMIT;

-- Reference.{ref_type,locator,citation,title}
BEGIN;

UPDATE reference_entities
   SET ref_type = CASE WHEN jsonb_typeof(data->'ref_type') = 'string' THEN data->>'ref_type' ELSE ref_type END,
       locator  = CASE WHEN jsonb_typeof(data->'locator')  = 'string' THEN data->>'locator'  ELSE locator  END,
       citation = CASE WHEN jsonb_typeof(data->'citation') = 'string' THEN data->>'citation' ELSE citation END,
       title    = CASE WHEN jsonb_typeof(data->'title')    = 'string' THEN data->>'title'    ELSE title    END
 WHERE data ? 'ref_type' OR data ? 'locator' OR data ? 'citation' OR data ? 'title';

UPDATE reference_entities
   SET data = data - 'ref_type' - 'locator' - 'citation' - 'title'
 WHERE data ? 'ref_type'
    OR data ? 'locator'
    OR data ? 'citation'
    OR data ? 'title';

COMMIT;

-- Principal.role_principal
BEGIN;

UPDATE principals
   SET role_principal = (data->>'role_principal')::boolean
 WHERE role_principal = false
   AND data ? 'role_principal'
   AND jsonb_typeof(data->'role_principal') = 'boolean';

-- Tolerate string "true"/"false" too — older captures may have
-- stored it as a JSON string rather than a real boolean.
UPDATE principals
   SET role_principal = (data->>'role_principal')::boolean
 WHERE role_principal = false
   AND data ? 'role_principal'
   AND jsonb_typeof(data->'role_principal') = 'string'
   AND data->>'role_principal' IN ('true', 'false');

UPDATE principals
   SET data = data - 'role_principal'
 WHERE data ? 'role_principal';

COMMIT;
