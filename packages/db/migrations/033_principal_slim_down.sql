-- 033_principal_slim_down.sql
-- ============================================================
-- Per decision_01KSDR_PRINCIPAL_SLIM_DOWN (this PR): Principal
-- carries only its identity slug (`name`) and prose `body_md`.
-- The `display_name`, `description`, and `type` keys that have
-- lived inside the `data` jsonb since the rename to Record are
-- removed — anything previously expressed via those keys belongs
-- in `body_md` prose (e.g. "Operates under: @alice" instead of
-- `type: agent`).
--
-- This migration also salvages each principal's prior `display_name`,
-- `description`, and `type` into a leading paragraph in `body_md`
-- so no information is lost — the operator can prune the salvage
-- block once the prose has been hand-edited.

BEGIN;

-- Salvage the dropped fields into body_md so prior intent isn't lost.
-- Composes a small markdown block listing the old display_name /
-- description / type, only when at least one of them was set. Prepends
-- to existing body_md so any pre-existing prose stays intact.
UPDATE principals
   SET body_md =
       NULLIF(
         CONCAT_WS(
           E'\n\n',
           NULLIF(TRIM(BOTH FROM CONCAT_WS(
             E'\n',
             CASE
               WHEN data ? 'display_name' AND length(trim(both from data->>'display_name')) > 0
                 THEN '# ' || (data->>'display_name')
               ELSE NULL
             END,
             CASE
               WHEN data ? 'type' AND data->>'type' IN ('person', 'agent')
                 THEN '*Type: ' || (data->>'type') || '*'
               ELSE NULL
             END,
             CASE
               WHEN data ? 'description' AND length(trim(both from data->>'description')) > 0
                 THEN data->>'description'
               ELSE NULL
             END
           )), ''),
           NULLIF(body_md, '')
         ),
         ''
       )
 WHERE data ? 'display_name' OR data ? 'description' OR data ? 'type';

-- Drop the three keys from data so future reads / writes don't see them.
UPDATE principals
   SET data = data - 'display_name' - 'description' - 'type'
 WHERE data ? 'display_name' OR data ? 'description' OR data ? 'type';

COMMIT;
