-- 075_account_grants.sql
-- ============================================================
-- Account-level access grants (decision_per_type_write_grants, wizard
-- redesign). The collaborators/API-token wizard lets a user grant access
-- to "my entire account" — the broadest scope, above per-org and
-- per-doco. An account grant from U to G means: G receives role R (with
-- optional per-type write set) on every organization U OWNS, and — via
-- the existing org→doco cascade in the access engine — every Doco under
-- those orgs, including ones created later. It is a LIVE grant, not a
-- snapshot: a new org U creates is automatically covered.
--
-- Stored as a thin edge keyed by (grantor, grantee). Roles reuse the
-- three-role set; write_types mirrors doco_users/org_users semantics
-- ('*' = every type; empty = read-only unless owner).
--
-- The runner wraps each migration in one BEGIN/COMMIT, so this file omits
-- transaction control. Idempotent (IF NOT EXISTS).
-- ============================================================

CREATE TABLE IF NOT EXISTS account_grants (
  grantor_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grantee_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('owner', 'writer', 'reader')),
  write_types     text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (grantor_user_id, grantee_user_id)
);

-- Lookup by grantee: "what whole-account grants does this principal hold?"
CREATE INDEX IF NOT EXISTS account_grants_grantee_idx
  ON account_grants (grantee_user_id);
