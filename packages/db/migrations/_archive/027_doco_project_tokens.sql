-- 027_doco_project_tokens.sql
-- ============================================================
-- Committable read-only "project tokens" for Docos. The Doco
-- owner mints one of these and stores it in the repo at
-- .doco/project-tokens.json — committable, non-secret in the sense
-- that anyone with repo read access is intended to also be able to
-- read the Doco. The MCP server uses it as a fallback when no
-- DOCO_ACCESS is set in .env, eliminating the per-container OAuth
-- dance for repos whose Doco is OK to be repo-readable.
--
-- Distinct from oauth_access_tokens:
--   - No collaborator linkage. The token represents the Doco itself,
--     not a person. `created_by_collaborator_id` records who minted
--     it (audit), not who acts as it.
--   - Scope is fixed: reader on exactly one Doco. No org grants, no
--     refresh, no scope widening.
--   - No expiry — the lifecycle is "committed-to-repo", which means
--     rotating the token requires a commit. `revoked` is the only
--     kill switch.
--   - Prefix is `doco_pt_` so it can never be confused with
--     `doco_at_` (OAuth access) or `doco_rt_` (OAuth refresh) in
--     logs.

CREATE TABLE IF NOT EXISTS doco_project_tokens (
  token                       text PRIMARY KEY,
  doco_id                     text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  created_by_collaborator_id  text NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
  label                       text,
  revoked                     boolean NOT NULL DEFAULT false,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  last_used_at                timestamptz
);

CREATE INDEX IF NOT EXISTS doco_project_tokens_doco_idx
  ON doco_project_tokens (doco_id) WHERE NOT revoked;
