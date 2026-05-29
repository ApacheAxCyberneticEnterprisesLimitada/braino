-- Non-rotating refresh tokens for headless / cloud-environment use.
--
-- A normal refresh token rotates on every use (the old one is revoked
-- and a fresh pair minted), which makes it unusable as a static value
-- pinned into a cloud environment's variable config: the first refresh
-- by any container would invalidate the pinned value for every other
-- fresh instance. Personal access tokens minted "for a cloud
-- environment" set this flag, and /oauth/token then reissues only the
-- short-lived access token while leaving the refresh token in place
-- (sliding its expiry forward). Every fresh instance mints its own
-- access token from the one shared, env-pinned refresh token, so new
-- containers inherit access without re-running OAuth.
--
-- Trade-off: a non-rotating refresh token forgoes refresh-reuse
-- detection. It is opt-in, scoped to what the minting user approved,
-- and revocable from the personal-access-token page, so the blast
-- radius is bounded and owner-acknowledged.
ALTER TABLE oauth_refresh_tokens
  ADD COLUMN IF NOT EXISTS non_rotating boolean NOT NULL DEFAULT false;
