-- 062_per_type_write_grants.sql
-- ============================================================
-- Per-type write access (decision_per_type_write_grants).
--
-- The access model moves to "grant up from reader": every collaborator
-- (human or agent) reads the whole Doco, and WRITE is granted per type.
-- The set of writable types lives alongside the role on each membership
-- row and inside each OAuth token's granted scope. The wildcard token
-- '*' means "write every type".
--
--   role 'owner'  → administers + writes everything (write_types ignored).
--   role 'reader' → reads everything; writes only the granted types.
--   role 'writer' → retained as a value but now means "writes everything"
--                   and is represented as write_types = {'*'} after this
--                   migration. New grants express write as reader + types.
--
-- BACKFILL SAFETY: every existing writer must keep full write access, so
-- existing writer rows get write_types = {'*'}. Readers/owners get '{}'.
-- This is the load-bearing step — verified against production-shaped data
-- before merge (the lesson from 060). Columns are added with a default of
-- the empty array so the ADD COLUMN itself can't fail on existing rows.
--
-- The runner wraps each migration in one BEGIN/COMMIT and records it in
-- applied_migrations, so this file omits transaction control. Every
-- statement is guarded (IF NOT EXISTS / idempotent UPDATE) so re-running
-- is safe.
-- ============================================================

-- 1. Membership rows: add the per-type write set, empty by default.
ALTER TABLE doco_users
  ADD COLUMN IF NOT EXISTS write_types text[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE org_users
  ADD COLUMN IF NOT EXISTS write_types text[] NOT NULL DEFAULT ARRAY[]::text[];

-- 2. Backfill: existing writers keep full write access as the wildcard.
--    Guarded so re-running doesn't clobber a later, narrower grant — only
--    a still-writer row with an empty set is widened.
UPDATE doco_users
   SET write_types = ARRAY['*']
 WHERE role = 'writer' AND write_types = ARRAY[]::text[];
UPDATE org_users
   SET write_types = ARRAY['*']
 WHERE role = 'writer' AND write_types = ARRAY[]::text[];

-- 3. OAuth token scope: parallel per-type write maps keyed by target id,
--    mirroring granted_doco_roles / granted_org_roles. A token that
--    granted writer on a target backfills to {"<target_id>": ["*"]}.
ALTER TABLE oauth_access_tokens
  ADD COLUMN IF NOT EXISTS granted_doco_write_types jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE oauth_access_tokens
  ADD COLUMN IF NOT EXISTS granted_org_write_types jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE oauth_refresh_tokens
  ADD COLUMN IF NOT EXISTS granted_doco_write_types jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE oauth_refresh_tokens
  ADD COLUMN IF NOT EXISTS granted_org_write_types jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE oauth_authorization_codes
  ADD COLUMN IF NOT EXISTS granted_doco_write_types jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE oauth_authorization_codes
  ADD COLUMN IF NOT EXISTS granted_org_write_types jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE oauth_device_authorizations
  ADD COLUMN IF NOT EXISTS granted_doco_write_types jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE oauth_device_authorizations
  ADD COLUMN IF NOT EXISTS granted_org_write_types jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 4. Backfill OAuth scope: every target whose granted role is 'writer'
--    gets a wildcard write-type entry so existing tokens keep full write.
--    Build the new jsonb by folding over the role map's keys. Guarded to
--    only touch rows that still have an empty write-type map.
UPDATE oauth_access_tokens t
   SET granted_doco_write_types = (
         SELECT COALESCE(jsonb_object_agg(k, '["*"]'::jsonb), '{}'::jsonb)
         FROM jsonb_object_keys(t.granted_doco_roles) AS k
         WHERE t.granted_doco_roles->>k = 'writer'
       )
 WHERE t.granted_doco_write_types = '{}'::jsonb
   AND EXISTS (
         SELECT 1 FROM jsonb_each_text(t.granted_doco_roles) e WHERE e.value = 'writer'
       );
UPDATE oauth_access_tokens t
   SET granted_org_write_types = (
         SELECT COALESCE(jsonb_object_agg(k, '["*"]'::jsonb), '{}'::jsonb)
         FROM jsonb_object_keys(t.granted_org_roles) AS k
         WHERE t.granted_org_roles->>k = 'writer'
       )
 WHERE t.granted_org_write_types = '{}'::jsonb
   AND EXISTS (
         SELECT 1 FROM jsonb_each_text(t.granted_org_roles) e WHERE e.value = 'writer'
       );

UPDATE oauth_refresh_tokens t
   SET granted_doco_write_types = (
         SELECT COALESCE(jsonb_object_agg(k, '["*"]'::jsonb), '{}'::jsonb)
         FROM jsonb_object_keys(t.granted_doco_roles) AS k
         WHERE t.granted_doco_roles->>k = 'writer'
       )
 WHERE t.granted_doco_write_types = '{}'::jsonb
   AND EXISTS (
         SELECT 1 FROM jsonb_each_text(t.granted_doco_roles) e WHERE e.value = 'writer'
       );
UPDATE oauth_refresh_tokens t
   SET granted_org_write_types = (
         SELECT COALESCE(jsonb_object_agg(k, '["*"]'::jsonb), '{}'::jsonb)
         FROM jsonb_object_keys(t.granted_org_roles) AS k
         WHERE t.granted_org_roles->>k = 'writer'
       )
 WHERE t.granted_org_write_types = '{}'::jsonb
   AND EXISTS (
         SELECT 1 FROM jsonb_each_text(t.granted_org_roles) e WHERE e.value = 'writer'
       );

UPDATE oauth_authorization_codes t
   SET granted_doco_write_types = (
         SELECT COALESCE(jsonb_object_agg(k, '["*"]'::jsonb), '{}'::jsonb)
         FROM jsonb_object_keys(t.granted_doco_roles) AS k
         WHERE t.granted_doco_roles->>k = 'writer'
       )
 WHERE t.granted_doco_write_types = '{}'::jsonb
   AND EXISTS (
         SELECT 1 FROM jsonb_each_text(t.granted_doco_roles) e WHERE e.value = 'writer'
       );
UPDATE oauth_authorization_codes t
   SET granted_org_write_types = (
         SELECT COALESCE(jsonb_object_agg(k, '["*"]'::jsonb), '{}'::jsonb)
         FROM jsonb_object_keys(t.granted_org_roles) AS k
         WHERE t.granted_org_roles->>k = 'writer'
       )
 WHERE t.granted_org_write_types = '{}'::jsonb
   AND EXISTS (
         SELECT 1 FROM jsonb_each_text(t.granted_org_roles) e WHERE e.value = 'writer'
       );

UPDATE oauth_device_authorizations t
   SET granted_doco_write_types = (
         SELECT COALESCE(jsonb_object_agg(k, '["*"]'::jsonb), '{}'::jsonb)
         FROM jsonb_object_keys(t.granted_doco_roles) AS k
         WHERE t.granted_doco_roles->>k = 'writer'
       )
 WHERE t.granted_doco_write_types = '{}'::jsonb
   AND EXISTS (
         SELECT 1 FROM jsonb_each_text(t.granted_doco_roles) e WHERE e.value = 'writer'
       );
UPDATE oauth_device_authorizations t
   SET granted_org_write_types = (
         SELECT COALESCE(jsonb_object_agg(k, '["*"]'::jsonb), '{}'::jsonb)
         FROM jsonb_object_keys(t.granted_org_roles) AS k
         WHERE t.granted_org_roles->>k = 'writer'
       )
 WHERE t.granted_org_write_types = '{}'::jsonb
   AND EXISTS (
         SELECT 1 FROM jsonb_each_text(t.granted_org_roles) e WHERE e.value = 'writer'
       );
