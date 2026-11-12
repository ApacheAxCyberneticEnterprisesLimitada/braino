ALTER TABLE oauth_authorization_codes
  ADD COLUMN IF NOT EXISTS resource text;

-- Pre-resource authorization codes cannot be safely exchanged for a
-- resource-bound token. They are transient, so invalidate them instead of
-- inventing an audience, then make the new invariant explicit.
DELETE FROM oauth_authorization_codes
  WHERE resource IS NULL;

ALTER TABLE oauth_authorization_codes
  ALTER COLUMN resource SET NOT NULL;

ALTER TABLE oauth_access_tokens
  ADD COLUMN IF NOT EXISTS resource text;

ALTER TABLE oauth_refresh_tokens
  ADD COLUMN IF NOT EXISTS resource text;
