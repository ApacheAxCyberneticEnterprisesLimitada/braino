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
-- Scope:
--   actions       — `verb` (text), `performed_at` (timestamptz)
--   logs          — `verb` (text), `happened_at` (timestamptz)
--   evals         — `kind` (text)
--   rules         — `kind`, `modality`, `severity`, `phase`,
--                   `on_violation` (all text)
--   states        — `kind` (text)
--   references_*  — `ref_type`, `locator`, `citation`, `title`
--                   (all text); table is `reference_entities`
--   principals    — `role_principal` (boolean)
--
-- After this migration:
--   - The columns are populated from the data jsonb for every
--     existing row.
--   - The promoted keys are removed from data so reads have one
--     source of truth.
--   - Indexes are added where the field is a routine filter key.
--
-- Idempotent: every ALTER uses IF NOT EXISTS, every UPDATE filters
-- to rows where the new column is still NULL (so re-running is a
-- no-op).

BEGIN;

-- ── actions ────────────────────────────────────────────────────
ALTER TABLE actions
  ADD COLUMN IF NOT EXISTS verb         text,
  ADD COLUMN IF NOT EXISTS performed_at timestamptz;

UPDATE actions
   SET verb = data->>'verb'
 WHERE verb IS NULL AND data ? 'verb';

UPDATE actions
   SET performed_at = (data->>'performed_at')::timestamptz
 WHERE performed_at IS NULL
   AND data ? 'performed_at'
   AND data->>'performed_at' ~ '^\d{4}-\d{2}-\d{2}';

UPDATE actions
   SET data = data - 'verb' - 'performed_at'
 WHERE data ? 'verb' OR data ? 'performed_at';

CREATE INDEX IF NOT EXISTS actions_verb_idx         ON actions (doco_id, verb);
CREATE INDEX IF NOT EXISTS actions_performed_at_idx ON actions (doco_id, performed_at DESC);

-- ── logs ───────────────────────────────────────────────────────
ALTER TABLE logs
  ADD COLUMN IF NOT EXISTS verb        text,
  ADD COLUMN IF NOT EXISTS happened_at timestamptz;

UPDATE logs
   SET verb = data->>'verb'
 WHERE verb IS NULL AND data ? 'verb';

UPDATE logs
   SET happened_at = (data->>'happened_at')::timestamptz
 WHERE happened_at IS NULL
   AND data ? 'happened_at'
   AND data->>'happened_at' ~ '^\d{4}-\d{2}-\d{2}';

UPDATE logs
   SET data = data - 'verb' - 'happened_at'
 WHERE data ? 'verb' OR data ? 'happened_at';

CREATE INDEX IF NOT EXISTS logs_verb_idx        ON logs (doco_id, verb);
CREATE INDEX IF NOT EXISTS logs_happened_at_idx ON logs (doco_id, happened_at DESC);

-- ── evals ──────────────────────────────────────────────────────
ALTER TABLE evals
  ADD COLUMN IF NOT EXISTS kind text;

UPDATE evals
   SET kind = data->>'kind'
 WHERE kind IS NULL AND data ? 'kind';

UPDATE evals
   SET data = data - 'kind'
 WHERE data ? 'kind';

CREATE INDEX IF NOT EXISTS evals_kind_idx ON evals (doco_id, kind);

-- ── rules ──────────────────────────────────────────────────────
-- `kind`, `modality`, `severity`, `phase`, `on_violation` are all
-- enum-shaped scalars used in policy evaluation. `predicate`,
-- `expected`, and `applies_to` are structured (objects / arrays)
-- and stay in `data`.
ALTER TABLE rules
  ADD COLUMN IF NOT EXISTS kind         text,
  ADD COLUMN IF NOT EXISTS modality     text,
  ADD COLUMN IF NOT EXISTS severity     text,
  ADD COLUMN IF NOT EXISTS phase        text,
  ADD COLUMN IF NOT EXISTS on_violation text;

UPDATE rules
   SET kind         = data->>'kind',
       modality     = data->>'modality',
       severity     = data->>'severity',
       phase        = data->>'phase',
       on_violation = data->>'on_violation'
 WHERE (kind IS NULL AND data ? 'kind')
    OR (modality IS NULL AND data ? 'modality')
    OR (severity IS NULL AND data ? 'severity')
    OR (phase IS NULL AND data ? 'phase')
    OR (on_violation IS NULL AND data ? 'on_violation');

UPDATE rules
   SET data = data - 'kind' - 'modality' - 'severity' - 'phase' - 'on_violation'
 WHERE data ? 'kind'
    OR data ? 'modality'
    OR data ? 'severity'
    OR data ? 'phase'
    OR data ? 'on_violation';

CREATE INDEX IF NOT EXISTS rules_kind_idx     ON rules (doco_id, kind);
CREATE INDEX IF NOT EXISTS rules_severity_idx ON rules (doco_id, severity);

-- ── states ─────────────────────────────────────────────────────
ALTER TABLE states
  ADD COLUMN IF NOT EXISTS kind text;

UPDATE states
   SET kind = data->>'kind'
 WHERE kind IS NULL AND data ? 'kind';

UPDATE states
   SET data = data - 'kind'
 WHERE data ? 'kind';

CREATE INDEX IF NOT EXISTS states_kind_idx ON states (doco_id, kind);

-- ── reference_entities ─────────────────────────────────────────
ALTER TABLE reference_entities
  ADD COLUMN IF NOT EXISTS ref_type text,
  ADD COLUMN IF NOT EXISTS locator  text,
  ADD COLUMN IF NOT EXISTS citation text,
  ADD COLUMN IF NOT EXISTS title    text;

UPDATE reference_entities
   SET ref_type = data->>'ref_type',
       locator  = data->>'locator',
       citation = data->>'citation',
       title    = data->>'title'
 WHERE (ref_type IS NULL AND data ? 'ref_type')
    OR (locator  IS NULL AND data ? 'locator')
    OR (citation IS NULL AND data ? 'citation')
    OR (title    IS NULL AND data ? 'title');

UPDATE reference_entities
   SET data = data - 'ref_type' - 'locator' - 'citation' - 'title'
 WHERE data ? 'ref_type'
    OR data ? 'locator'
    OR data ? 'citation'
    OR data ? 'title';

CREATE INDEX IF NOT EXISTS reference_entities_ref_type_idx
  ON reference_entities (doco_id, ref_type);

-- ── principals ─────────────────────────────────────────────────
-- `role_principal` is a boolean flag that the principals POST
-- route sets for reserved role names (user/human/doco-host/github).
-- It's read by the org-tree perspective to omit role principals
-- from the rendered chart. Promote it to a typed column.
ALTER TABLE principals
  ADD COLUMN IF NOT EXISTS role_principal boolean NOT NULL DEFAULT false;

UPDATE principals
   SET role_principal = COALESCE((data->>'role_principal')::boolean, false)
 WHERE role_principal = false AND data ? 'role_principal';

UPDATE principals
   SET data = data - 'role_principal'
 WHERE data ? 'role_principal';

CREATE INDEX IF NOT EXISTS principals_role_idx
  ON principals (doco_id) WHERE NOT role_principal;

COMMIT;
