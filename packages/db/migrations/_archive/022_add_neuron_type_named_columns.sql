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
--
-- The backfills are gated on the legacy `summary` column still existing
-- — migration 023 drops it once the rename is complete, and on a fresh
-- schema (post-023 baseline) the column never existed at all. The guard
-- makes 022 idempotent across replay scenarios: existing prod DBs run
-- the backfill once before 023 strips the column, fresh DBs skip it.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'intents' AND column_name = 'summary') THEN
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
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'decisions' AND column_name = 'summary') THEN
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
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'rules' AND column_name = 'summary') THEN
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
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'actions' AND column_name = 'summary') THEN
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
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'logs' AND column_name = 'summary') THEN
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
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'evals' AND column_name = 'summary') THEN
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
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reference_entities' AND column_name = 'summary') THEN
    UPDATE reference_entities
       SET reference = COALESCE(NULLIF(summary, ''), '')
     WHERE reference = '';
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'states' AND column_name = 'summary') THEN
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
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ideas' AND column_name = 'summary') THEN
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
  END IF;
END $$;

-- The NULL coalescing above lets us treat empty-string defaults as
-- "needs backfill" without re-running on rows that explicitly chose
-- empty content. If a row legitimately has no summary/body_md, the
-- WHERE clause still fires once (intent stays '') and the next
-- application of this migration would skip it via applied_migrations.
