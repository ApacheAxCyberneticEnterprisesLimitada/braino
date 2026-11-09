ALTER TABLE github_connections
  ADD COLUMN IF NOT EXISTS sync_token text,
  ADD COLUMN IF NOT EXISTS sync_started_at timestamptz;
