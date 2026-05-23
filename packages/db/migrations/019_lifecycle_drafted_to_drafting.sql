-- Rename the `drafted` lifecycle stage to `drafting`.
--
-- The lifecycle vocabulary used to be a past-participle ("drafted",
-- "proposed", "active", "retired"), which read inconsistently next to
-- the active/in-flight stages. Per project owner, the first stage is
-- now `drafting` — present-progressive — to convey "work in motion,"
-- consistent with how the rest of the vocabulary reads.
--
-- The lifecycle value is mirrored in both the typed `lifecycle` column
-- and the entity's `data` jsonb bag (writes upsert both). Update both
-- so reads off either path agree.

DO $rename_lifecycle_drafted_to_drafting$
BEGIN
  UPDATE intents                       SET lifecycle = 'drafting' WHERE lifecycle = 'drafted';
  UPDATE decisions                     SET lifecycle = 'drafting' WHERE lifecycle = 'drafted';
  UPDATE rules                         SET lifecycle = 'drafting' WHERE lifecycle = 'drafted';
  UPDATE actions                       SET lifecycle = 'drafting' WHERE lifecycle = 'drafted';
  UPDATE logs                          SET lifecycle = 'drafting' WHERE lifecycle = 'drafted';
  UPDATE evals                         SET lifecycle = 'drafting' WHERE lifecycle = 'drafted';
  UPDATE reference_entities            SET lifecycle = 'drafting' WHERE lifecycle = 'drafted';
  UPDATE ideas                         SET lifecycle = 'drafting' WHERE lifecycle = 'drafted';
  UPDATE states                        SET lifecycle = 'drafting' WHERE lifecycle = 'drafted';
  UPDATE principals                    SET lifecycle = 'drafting' WHERE lifecycle = 'drafted';
  UPDATE guidance_primitives           SET lifecycle = 'drafting' WHERE lifecycle = 'drafted';
  UPDATE neuron_authoring_primitives   SET lifecycle = 'drafting' WHERE lifecycle = 'drafted';

  UPDATE intents                       SET data = jsonb_set(data, '{lifecycle}', '"drafting"') WHERE data->>'lifecycle' = 'drafted';
  UPDATE decisions                     SET data = jsonb_set(data, '{lifecycle}', '"drafting"') WHERE data->>'lifecycle' = 'drafted';
  UPDATE rules                         SET data = jsonb_set(data, '{lifecycle}', '"drafting"') WHERE data->>'lifecycle' = 'drafted';
  UPDATE actions                       SET data = jsonb_set(data, '{lifecycle}', '"drafting"') WHERE data->>'lifecycle' = 'drafted';
  UPDATE logs                          SET data = jsonb_set(data, '{lifecycle}', '"drafting"') WHERE data->>'lifecycle' = 'drafted';
  UPDATE evals                         SET data = jsonb_set(data, '{lifecycle}', '"drafting"') WHERE data->>'lifecycle' = 'drafted';
  UPDATE reference_entities            SET data = jsonb_set(data, '{lifecycle}', '"drafting"') WHERE data->>'lifecycle' = 'drafted';
  UPDATE ideas                         SET data = jsonb_set(data, '{lifecycle}', '"drafting"') WHERE data->>'lifecycle' = 'drafted';
  UPDATE states                        SET data = jsonb_set(data, '{lifecycle}', '"drafting"') WHERE data->>'lifecycle' = 'drafted';
  UPDATE principals                    SET data = jsonb_set(data, '{lifecycle}', '"drafting"') WHERE data->>'lifecycle' = 'drafted';
  UPDATE guidance_primitives           SET data = jsonb_set(data, '{lifecycle}', '"drafting"') WHERE data->>'lifecycle' = 'drafted';
  UPDATE neuron_authoring_primitives   SET data = jsonb_set(data, '{lifecycle}', '"drafting"') WHERE data->>'lifecycle' = 'drafted';
END
$rename_lifecycle_drafted_to_drafting$;
