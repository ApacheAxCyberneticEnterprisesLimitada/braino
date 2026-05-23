-- 022_add_neuron_type_named_columns.sql
-- ============================================================
-- Add a single type-named text column to each neuron table, holding the
-- full prose content for that neuron. This is step 1 of a two-step
-- rename that collapses `summary` + `body_md` + a few type-specific
-- fields (`title` for intents, `name`/`description` for evals) into one
-- type-named field per neuron type.
--
-- Step 1 (this migration): additive. Add and backfill `intent` /
--   `decision` / `rule` / `action` / `log` / `eval` / `reference` /
--   `state` / `idea` columns. Old columns (`summary`, `body_md`,
--   `data->'title'`, etc.) stay in place. Code dual-writes and prefers
--   the new column when reading.
--
-- Step 2 (follow-up migration, after prod verification): drop the
--   legacy columns and strip the merged keys from `data` jsonb.
--
-- Primitives are out of scope for this rename — they keep `summary` +
-- `body_md` for now.
-- ============================================================

ALTER TABLE intents             ADD COLUMN IF NOT EXISTS intent    text NOT NULL DEFAULT '';
ALTER TABLE decisions           ADD COLUMN IF NOT EXISTS decision  text NOT NULL DEFAULT '';
ALTER TABLE rules               ADD COLUMN IF NOT EXISTS rule      text NOT NULL DEFAULT '';
ALTER TABLE actions             ADD COLUMN IF NOT EXISTS action    text NOT NULL DEFAULT '';
ALTER TABLE logs                ADD COLUMN IF NOT EXISTS log       text NOT NULL DEFAULT '';
ALTER TABLE evals               ADD COLUMN IF NOT EXISTS eval      text NOT NULL DEFAULT '';
ALTER TABLE reference_entities  ADD COLUMN IF NOT EXISTS reference text NOT NULL DEFAULT '';
ALTER TABLE states              ADD COLUMN IF NOT EXISTS state     text NOT NULL DEFAULT '';
ALTER TABLE ideas               ADD COLUMN IF NOT EXISTS idea      text NOT NULL DEFAULT '';

-- Backfill. For most types: summary + (blank line) + body_md, both
-- trimmed, omitted when empty. For intents: prepend `title` when it
-- differs from summary. For evals: prepend `name`, then `description`,
-- then summary, then body_md.

UPDATE intents
   SET intent = NULLIF(
                  TRIM(BOTH E'\n' FROM CONCAT_WS(
                    E'\n\n',
                    NULLIF(NULLIF(data->>'title', summary), ''),
                    NULLIF(summary, ''),
                    NULLIF(body_md, '')
                  )),
                  ''
                )
 WHERE intent = '';

UPDATE decisions
   SET decision = NULLIF(
                    TRIM(BOTH E'\n' FROM CONCAT_WS(
                      E'\n\n',
                      NULLIF(summary, ''),
                      NULLIF(body_md, '')
                    )),
                    ''
                  )
 WHERE decision = '';

UPDATE rules
   SET rule = NULLIF(
                TRIM(BOTH E'\n' FROM CONCAT_WS(
                  E'\n\n',
                  NULLIF(summary, ''),
                  NULLIF(body_md, '')
                )),
                ''
              )
 WHERE rule = '';

UPDATE actions
   SET action = NULLIF(
                  TRIM(BOTH E'\n' FROM CONCAT_WS(
                    E'\n\n',
                    NULLIF(summary, ''),
                    NULLIF(body_md, '')
                  )),
                  ''
                )
 WHERE action = '';

UPDATE logs
   SET log = NULLIF(
               TRIM(BOTH E'\n' FROM CONCAT_WS(
                 E'\n\n',
                 NULLIF(summary, ''),
                 NULLIF(body_md, '')
               )),
               ''
             )
 WHERE log = '';

UPDATE evals
   SET eval = NULLIF(
                TRIM(BOTH E'\n' FROM CONCAT_WS(
                  E'\n\n',
                  NULLIF(data->>'name', ''),
                  NULLIF(NULLIF(data->>'description', data->>'name'), ''),
                  NULLIF(NULLIF(summary, data->>'name'), ''),
                  NULLIF(body_md, '')
                )),
                ''
              )
 WHERE eval = '';

UPDATE reference_entities
   SET reference = COALESCE(NULLIF(summary, ''), '')
 WHERE reference = '';

UPDATE states
   SET state = NULLIF(
                 TRIM(BOTH E'\n' FROM CONCAT_WS(
                   E'\n\n',
                   NULLIF(summary, ''),
                   NULLIF(body_md, '')
                 )),
                 ''
               )
 WHERE state = '';

UPDATE ideas
   SET idea = NULLIF(
                TRIM(BOTH E'\n' FROM CONCAT_WS(
                  E'\n\n',
                  NULLIF(summary, ''),
                  NULLIF(body_md, '')
                )),
                ''
              )
 WHERE idea = '';

-- The NULL coalescing above lets us treat empty-string defaults as
-- "needs backfill" without re-running on rows that explicitly chose
-- empty content. If a row legitimately has no summary/body_md, the
-- WHERE clause still fires once (intent stays '') and the next
-- application of this migration would skip it via applied_migrations.
