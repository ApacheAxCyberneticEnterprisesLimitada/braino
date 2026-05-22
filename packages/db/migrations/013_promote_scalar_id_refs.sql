-- 013_promote_id_refs_and_data_jsonb.sql
-- ============================================================
-- Promote scalar (single-ID) frontmatter refs from raw_yaml into
-- typed FK columns. The synapses table already materializes
-- ID-array refs (D-017 "fields-as-synapses"); this change pulls
-- the *scalar* refs into the row itself so the common joins are
-- real foreign keys with real constraints.
--
-- Out of scope (intentionally deferred):
--   - Renaming raw_yaml (text) → data (jsonb). The bulk of read
--     and write paths still treat raw_yaml as a JSON string;
--     flipping the column type without consumer updates would
--     break runtime queries. That conversion gets its own
--     migration once consumers move off the string assumption.
--   - Promoting polymorphic refs (target, target_ref, born_from,
--     superseded_by where it points across types). FK constraints
--     can't bind across tables; those stay in raw_yaml for now.
-- ============================================================

-- 1. New FK columns. All nullable so the migration is non-breaking
--    for in-flight writes; backfill populates them from raw_yaml
--    below.

ALTER TABLE intents
  ADD COLUMN IF NOT EXISTS parent_intent_id text;
CREATE INDEX IF NOT EXISTS intents_parent_intent_idx ON intents (parent_intent_id);

ALTER TABLE ideas
  ADD COLUMN IF NOT EXISTS proposer_id text;
CREATE INDEX IF NOT EXISTS ideas_proposer_idx ON ideas (proposer_id);

ALTER TABLE decisions
  ADD COLUMN IF NOT EXISTS decided_by text,
  ADD COLUMN IF NOT EXISTS superseded_by_decision_id text;
CREATE INDEX IF NOT EXISTS decisions_decided_by_idx    ON decisions (decided_by);
CREATE INDEX IF NOT EXISTS decisions_superseded_by_idx ON decisions (superseded_by_decision_id);

ALTER TABLE actions
  ADD COLUMN IF NOT EXISTS actor_id text;
CREATE INDEX IF NOT EXISTS actions_actor_idx ON actions (actor_id);

ALTER TABLE logs
  ADD COLUMN IF NOT EXISTS actor_id    text,
  ADD COLUMN IF NOT EXISTS template_id text;
CREATE INDEX IF NOT EXISTS logs_actor_idx    ON logs (actor_id);
CREATE INDEX IF NOT EXISTS logs_template_idx ON logs (template_id);

-- 2. Backfill the new columns from raw_yaml. The cast to jsonb is
--    safe because the column has carried JSON since the Postgres
--    cut. Wrapped in a DO block conditional on raw_yaml still
--    being present so this is a no-op on fresh installs (where
--    schema.sql + migration 014 leave the bag as `data jsonb` and
--    nothing to backfill from).

DO $backfill_from_raw_yaml$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'intents'
       AND column_name = 'raw_yaml'
  ) THEN
    RETURN;
  END IF;

  UPDATE intents
     SET parent_intent_id = raw_yaml::jsonb->>'parent_intent_id'
   WHERE parent_intent_id IS NULL
     AND raw_yaml::jsonb->>'parent_intent_id' IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM intents parent
        WHERE parent.id = raw_yaml::jsonb->>'parent_intent_id'
     );

  UPDATE ideas
     SET proposer_id = raw_yaml::jsonb->>'proposer_id'
   WHERE proposer_id IS NULL
     AND raw_yaml::jsonb->>'proposer_id' IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM collaborators proposer
        WHERE proposer.id = raw_yaml::jsonb->>'proposer_id'
     );

  UPDATE decisions
     SET decided_by = raw_yaml::jsonb->>'decided_by'
   WHERE decided_by IS NULL
     AND raw_yaml::jsonb->>'decided_by' IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM collaborators decider
        WHERE decider.id = raw_yaml::jsonb->>'decided_by'
     );

  -- superseded_by in raw_yaml is polymorphic (could point at
  -- non-decision targets historically). Only backfill when it's a
  -- decision_<ulid> shape so the FK constraint below is safe.
  UPDATE decisions
     SET superseded_by_decision_id = raw_yaml::jsonb->>'superseded_by'
   WHERE superseded_by_decision_id IS NULL
     AND raw_yaml::jsonb->>'superseded_by' IS NOT NULL
     AND raw_yaml::jsonb->>'superseded_by' LIKE 'decision\_%' ESCAPE '\'
     AND EXISTS (
       SELECT 1 FROM decisions superseding
        WHERE superseding.id = raw_yaml::jsonb->>'superseded_by'
     );

  UPDATE actions
     SET actor_id = raw_yaml::jsonb->>'actor_id'
   WHERE actor_id IS NULL
     AND raw_yaml::jsonb->>'actor_id' IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM principals actor
        WHERE actor.id = raw_yaml::jsonb->>'actor_id'
     );

  UPDATE logs
     SET actor_id = raw_yaml::jsonb->>'actor_id'
   WHERE actor_id IS NULL
     AND raw_yaml::jsonb->>'actor_id' IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM principals actor
        WHERE actor.id = raw_yaml::jsonb->>'actor_id'
     );

  UPDATE logs
     SET template_id = raw_yaml::jsonb->>'template_id'
   WHERE template_id IS NULL
     AND raw_yaml::jsonb->>'template_id' IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM actions template
        WHERE template.id = raw_yaml::jsonb->>'template_id'
     );
END
$backfill_from_raw_yaml$;

-- 3. Foreign-key constraints AFTER backfill so the constraint check
--    passes on every populated row. NOT VALID + VALIDATE so the
--    initial constraint check doesn't take an ACCESS EXCLUSIVE lock
--    on a hot table — VALIDATE uses a weaker SHARE UPDATE EXCLUSIVE
--    that doesn't block reads/writes.

ALTER TABLE intents
  ADD CONSTRAINT intents_parent_intent_fk
  FOREIGN KEY (parent_intent_id) REFERENCES intents(id) ON DELETE SET NULL
  NOT VALID;
ALTER TABLE intents VALIDATE CONSTRAINT intents_parent_intent_fk;

ALTER TABLE ideas
  ADD CONSTRAINT ideas_proposer_fk
  FOREIGN KEY (proposer_id) REFERENCES collaborators(id) ON DELETE SET NULL
  NOT VALID;
ALTER TABLE ideas VALIDATE CONSTRAINT ideas_proposer_fk;

ALTER TABLE decisions
  ADD CONSTRAINT decisions_decided_by_fk
  FOREIGN KEY (decided_by) REFERENCES collaborators(id) ON DELETE SET NULL
  NOT VALID;
ALTER TABLE decisions VALIDATE CONSTRAINT decisions_decided_by_fk;

ALTER TABLE decisions
  ADD CONSTRAINT decisions_superseded_by_decision_fk
  FOREIGN KEY (superseded_by_decision_id) REFERENCES decisions(id) ON DELETE SET NULL
  NOT VALID;
ALTER TABLE decisions VALIDATE CONSTRAINT decisions_superseded_by_decision_fk;

-- actor_id is RESTRICT, not SET NULL: an Action / Log without an
-- actor is a broken record. Writes that drop the principal must
-- update the entity row too.
ALTER TABLE actions
  ADD CONSTRAINT actions_actor_fk
  FOREIGN KEY (actor_id) REFERENCES principals(id) ON DELETE RESTRICT
  NOT VALID;
ALTER TABLE actions VALIDATE CONSTRAINT actions_actor_fk;

ALTER TABLE logs
  ADD CONSTRAINT logs_actor_fk
  FOREIGN KEY (actor_id) REFERENCES principals(id) ON DELETE RESTRICT
  NOT VALID;
ALTER TABLE logs VALIDATE CONSTRAINT logs_actor_fk;

ALTER TABLE logs
  ADD CONSTRAINT logs_template_fk
  FOREIGN KEY (template_id) REFERENCES actions(id) ON DELETE SET NULL
  NOT VALID;
ALTER TABLE logs VALIDATE CONSTRAINT logs_template_fk;
