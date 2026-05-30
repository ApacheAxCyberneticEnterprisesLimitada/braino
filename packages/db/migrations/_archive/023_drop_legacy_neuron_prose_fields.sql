-- 023_drop_legacy_neuron_prose_fields.sql
-- ============================================================
-- Step 2 of the summary/body_md → <type> rename (companion to 022).
--
-- For the 9 migrated neurons (intents, decisions, rules, actions,
-- logs, evals, reference_entities, states, ideas):
--   - Drop the `summary` column.
--   - Drop the `body_md` column where it exists.
--   - Strip the merged keys from `data` jsonb: `summary`, `body_md`,
--     plus `title` (intents) and `name` + `description` (evals).
--
-- Structural fields stay: `predicate` on rules, `criterion` on evals,
-- `verb` on actions/logs, `kind` on states/evals, `invariants`, FK
-- columns (actor_id, decided_by, parent_intent_id, etc.).
--
-- Primitives (guidance_primitives, neuron_authoring_primitives) and
-- principals retain summary + body_md for now.
-- ============================================================

-- intents — also drop `title` from data (was merged into intent by 022).
ALTER TABLE intents             DROP COLUMN IF EXISTS summary;
ALTER TABLE intents             DROP COLUMN IF EXISTS body_md;
UPDATE intents SET data = data - 'summary' - 'body_md' - 'title';

-- decisions
ALTER TABLE decisions           DROP COLUMN IF EXISTS summary;
ALTER TABLE decisions           DROP COLUMN IF EXISTS body_md;
UPDATE decisions SET data = data - 'summary' - 'body_md';

-- rules — predicate stays.
ALTER TABLE rules               DROP COLUMN IF EXISTS summary;
ALTER TABLE rules               DROP COLUMN IF EXISTS body_md;
UPDATE rules SET data = data - 'summary' - 'body_md';

-- actions
ALTER TABLE actions             DROP COLUMN IF EXISTS summary;
ALTER TABLE actions             DROP COLUMN IF EXISTS body_md;
UPDATE actions SET data = data - 'summary' - 'body_md';

-- logs
ALTER TABLE logs                DROP COLUMN IF EXISTS summary;
ALTER TABLE logs                DROP COLUMN IF EXISTS body_md;
UPDATE logs SET data = data - 'summary' - 'body_md';

-- evals — also drop `name` + `description` from data (merged into eval by 022).
ALTER TABLE evals               DROP COLUMN IF EXISTS summary;
ALTER TABLE evals               DROP COLUMN IF EXISTS body_md;
UPDATE evals SET data = data - 'summary' - 'body_md' - 'name' - 'description';

-- reference_entities — no body_md to drop.
ALTER TABLE reference_entities  DROP COLUMN IF EXISTS summary;
UPDATE reference_entities SET data = data - 'summary';

-- states
ALTER TABLE states              DROP COLUMN IF EXISTS summary;
ALTER TABLE states              DROP COLUMN IF EXISTS body_md;
UPDATE states SET data = data - 'summary' - 'body_md';

-- ideas
ALTER TABLE ideas               DROP COLUMN IF EXISTS summary;
ALTER TABLE ideas               DROP COLUMN IF EXISTS body_md;
UPDATE ideas SET data = data - 'summary' - 'body_md';
