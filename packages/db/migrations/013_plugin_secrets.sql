-- Non-secret settings live with the installation; secret values are sealed
-- independently so Admin can list configured names without ever selecting a
-- plaintext value. The installation foreign key is the workspace boundary.
ALTER TABLE plugin_installations
  ADD COLUMN IF NOT EXISTS configuration jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS plugin_installation_secrets (
  installation_id    text NOT NULL REFERENCES plugin_installations(id) ON DELETE CASCADE,
  name               text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{0,63}$'),
  value_sealed       text NOT NULL,
  updated_by_user_id text NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, name)
);
