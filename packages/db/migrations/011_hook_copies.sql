-- What the alert about an agent's Braino setup keeps (Alexander, 2026-11-12,
-- "Make agents aware of outdated instructions").
--
-- hook_copies: the copies of the Braino hook's script that named themselves
-- to Braino, one per workspace, person, agent and project, with when each was
-- last seen and since when it has been another copy than the one Braino
-- serves.
CREATE TABLE IF NOT EXISTS hook_copies (
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent         text NOT NULL,
  project       text NOT NULL,
  seen_at       timestamptz NOT NULL DEFAULT now(),
  old_since     timestamptz,
  PRIMARY KEY (workspace_id, user_id, agent, project)
);

-- silence_alerts.setup: on an agent's alert, what is wrong with its setup, an
-- old copy of the script or none heard from; null on a silence alert.
ALTER TABLE silence_alerts
  ADD COLUMN IF NOT EXISTS setup text
    CHECK (setup IS NULL OR (agent IS NOT NULL AND setup IN ('old', 'missing')));

-- An agent may have gone quiet and have an outdated setup at once, so the key
-- that kept one alert per agent keeps one of each kind.
CREATE UNIQUE INDEX IF NOT EXISTS silence_alerts_agent_setup_idx
  ON silence_alerts (workspace_id, user_id, agent, coalesce(setup, ''))
  WHERE agent IS NOT NULL;
DROP INDEX IF EXISTS silence_alerts_agent_idx;
