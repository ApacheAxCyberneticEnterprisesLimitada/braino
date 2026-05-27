-- 050 (2026-05-27): make the agent -> human ownership chain explicit
-- on existing databases. The baseline schema already includes owner_id;
-- this migration catches older deployments whose collaborators table
-- predates that column and indexes owned-agent lookups.

ALTER TABLE collaborators
  ADD COLUMN IF NOT EXISTS owner_id text REFERENCES collaborators(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS collaborators_owner_idx
  ON collaborators (owner_id);
