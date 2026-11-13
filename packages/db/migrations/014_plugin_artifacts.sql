-- Persist the exact component bytes that a workspace owner installs. Existing
-- digest-only rows remain non-executable until reinstalled with their bytes;
-- the not-valid foreign key enforces the invariant for every new or updated
-- installation without fabricating an artifact for an old claim.
CREATE TABLE IF NOT EXISTS plugin_artifacts (
  digest      text PRIMARY KEY CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  component   bytea NOT NULL CHECK (octet_length(component) BETWEEN 1 AND 16777216),
  created_at  timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'plugin_installations_artifact_digest_fkey'
  ) THEN
    ALTER TABLE plugin_installations
      ADD CONSTRAINT plugin_installations_artifact_digest_fkey
      FOREIGN KEY (artifact_digest) REFERENCES plugin_artifacts(digest) NOT VALID;
  END IF;
END
$$;
