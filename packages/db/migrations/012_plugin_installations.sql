-- A marketplace artifact becomes executable only through a workspace-bound
-- installation. The manifest is the canonical permission declaration and the
-- immutable digest pins exactly what the owner approved. Hosted Braino may
-- share physical workers, but this identity never spans workspaces.
CREATE TABLE IF NOT EXISTS plugin_installations (
  id                  text PRIMARY KEY,
  workspace_id        text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  manifest            jsonb NOT NULL
                        CHECK (jsonb_typeof(manifest) = 'object')
                        CHECK (jsonb_typeof(manifest->'id') = 'string')
                        CHECK (manifest->>'id' <> ''),
  artifact_digest     text NOT NULL
                        CHECK (artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
  enabled             boolean NOT NULL DEFAULT true,
  created_by_user_id  text NOT NULL REFERENCES users(id),
  updated_by_user_id  text NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS plugin_installations_workspace_plugin_idx
  ON plugin_installations (workspace_id, (manifest->>'id'));
CREATE INDEX IF NOT EXISTS plugin_installations_workspace_enabled_idx
  ON plugin_installations (workspace_id, enabled);
