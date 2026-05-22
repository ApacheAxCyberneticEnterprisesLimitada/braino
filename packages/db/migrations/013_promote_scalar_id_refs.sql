-- 013_promote_scalar_id_refs.sql
-- ============================================================
-- Promote scalar (single-ID) frontmatter refs into typed FK columns.
-- The synapses table already materializes ID-array refs (D-017
-- "fields-as-synapses"); this change pulls the *scalar* refs into
-- the row itself so the common joins are real foreign keys with
-- real constraints.
--
-- Polymorphic refs (target, target_ref, born_from, superseded_by
-- where it points across types) stay in the `data` jsonb bag — FK
-- constraints can't bind across tables.
-- ============================================================

-- 1. New FK columns. All nullable so the migration is non-breaking
--    for in-flight writes; backfill populates them from the `data`
--    jsonb bag below.

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

-- 2. Backfill the new columns from the `data` jsonb bag, only when
--    the referenced row exists so the FK constraint validation
--    below holds on every populated row.

UPDATE intents
   SET parent_intent_id = data->>'parent_intent_id'
 WHERE parent_intent_id IS NULL
   AND data->>'parent_intent_id' IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM intents parent
      WHERE parent.id = intents.data->>'parent_intent_id'
   );

UPDATE ideas
   SET proposer_id = data->>'proposer_id'
 WHERE proposer_id IS NULL
   AND data->>'proposer_id' IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM collaborators proposer
      WHERE proposer.id = ideas.data->>'proposer_id'
   );

UPDATE decisions
   SET decided_by = data->>'decided_by'
 WHERE decided_by IS NULL
   AND data->>'decided_by' IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM collaborators decider
      WHERE decider.id = decisions.data->>'decided_by'
   );

-- superseded_by in the data bag is polymorphic (could point at
-- non-decision targets historically). Only backfill when it's a
-- decision_<ulid> shape so the FK constraint below is safe.
UPDATE decisions
   SET superseded_by_decision_id = data->>'superseded_by'
 WHERE superseded_by_decision_id IS NULL
   AND data->>'superseded_by' IS NOT NULL
   AND data->>'superseded_by' LIKE 'decision\_%' ESCAPE '\'
   AND EXISTS (
     SELECT 1 FROM decisions superseding
      WHERE superseding.id = decisions.data->>'superseded_by'
   );

UPDATE actions
   SET actor_id = data->>'actor_id'
 WHERE actor_id IS NULL
   AND data->>'actor_id' IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM principals actor
      WHERE actor.id = actions.data->>'actor_id'
   );

UPDATE logs
   SET actor_id = data->>'actor_id'
 WHERE actor_id IS NULL
   AND data->>'actor_id' IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM principals actor
      WHERE actor.id = logs.data->>'actor_id'
   );

UPDATE logs
   SET template_id = data->>'template_id'
 WHERE template_id IS NULL
   AND data->>'template_id' IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM actions template
      WHERE template.id = logs.data->>'template_id'
   );

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

-- 4. GIN indexes on `data` for path-based filtering. jsonb_path_ops
--    is the smaller/faster opclass for the @> and -> lookups that
--    perspectives + capture-time predicates do.

DO $add_data_gin_indexes$
DECLARE
  tname text;
BEGIN
  FOREACH tname IN ARRAY ARRAY[
    'intents',
    'ideas',
    'rules',
    'decisions',
    'actions',
    'logs',
    'evals',
    'states',
    'reference_entities',
    'guidance_primitives',
    'neuron_authoring_primitives'
  ]
  LOOP
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I USING gin (data jsonb_path_ops)',
      tname || '_data_gin',
      tname
    );
  END LOOP;
END
$add_data_gin_indexes$;
