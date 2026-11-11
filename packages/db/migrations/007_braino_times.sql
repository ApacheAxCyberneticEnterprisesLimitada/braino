ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS times_timezone text NOT NULL DEFAULT 'America/Los_Angeles';

ALTER TABLE times_editions
  ADD COLUMN IF NOT EXISTS edition_day date;

UPDATE times_editions
   SET edition_day = (published_at AT TIME ZONE 'America/Los_Angeles')::date
 WHERE edition_day IS NULL;

DELETE FROM times_editions edition
 WHERE edition.ctid IN (
   SELECT duplicate.ctid
     FROM (
       SELECT ctid,
              row_number() OVER (
                PARTITION BY workspace_id, cadence, edition_day
                ORDER BY published_at DESC, ctid DESC
              ) AS position
         FROM times_editions
     ) duplicate
    WHERE duplicate.position > 1
 );

ALTER TABLE times_editions
  ALTER COLUMN edition_day SET NOT NULL;

ALTER TABLE times_editions
  DROP CONSTRAINT IF EXISTS times_editions_pkey;

ALTER TABLE times_editions
  ADD PRIMARY KEY (workspace_id, cadence, edition_day);
