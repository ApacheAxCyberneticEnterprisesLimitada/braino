-- 077_token_names_not_agent_users.sql
--
-- OAuth/device credentials are tokens named by a human, not user rows.
-- Older approvals created `users.kind = 'agent'` rows and stored those ids
-- as the OAuth token subject. Move those credentials back onto the owning
-- human user and preserve the former agent display name as token_name.

ALTER TABLE oauth_authorization_codes
  ADD COLUMN IF NOT EXISTS token_name text;
ALTER TABLE oauth_access_tokens
  ADD COLUMN IF NOT EXISTS token_name text;
ALTER TABLE oauth_refresh_tokens
  ADD COLUMN IF NOT EXISTS token_name text;
ALTER TABLE oauth_device_authorizations
  ADD COLUMN IF NOT EXISTS token_name text;

CREATE TEMP TABLE legacy_agent_users ON COMMIT DROP AS
SELECT
  id,
  COALESCE(owner_id, NULLIF(data->>'owner_id', '')) AS owner_id,
  COALESCE(NULLIF(data->>'name', ''), NULLIF(data->>'display_name', ''), github_login, id) AS token_name
FROM users
WHERE kind = 'agent'
  AND COALESCE(owner_id, NULLIF(data->>'owner_id', '')) IS NOT NULL;

UPDATE oauth_authorization_codes c
SET user_id = a.owner_id,
    token_name = COALESCE(NULLIF(c.token_name, ''), a.token_name, oc.client_name)
FROM legacy_agent_users a, oauth_clients oc
WHERE c.user_id = a.id
  AND oc.client_id = c.client_id;

UPDATE oauth_access_tokens t
SET user_id = a.owner_id,
    token_name = COALESCE(NULLIF(t.token_name, ''), a.token_name, oc.client_name)
FROM legacy_agent_users a, oauth_clients oc
WHERE t.user_id = a.id
  AND oc.client_id = t.client_id;

UPDATE oauth_refresh_tokens t
SET user_id = a.owner_id,
    token_name = COALESCE(NULLIF(t.token_name, ''), a.token_name, oc.client_name)
FROM legacy_agent_users a, oauth_clients oc
WHERE t.user_id = a.id
  AND oc.client_id = t.client_id;

UPDATE oauth_device_authorizations d
SET user_id = a.owner_id,
    token_name = COALESCE(NULLIF(d.token_name, ''), a.token_name, oc.client_name)
FROM legacy_agent_users a, oauth_clients oc
WHERE d.user_id = a.id
  AND oc.client_id = d.client_id;

-- Preserve visible provenance: old metadata stored the OAuth client under
-- token_name, because the named "agent user" was the subject. Move that old
-- value to client_name when needed, then set token_name to the legacy agent
-- display name.
ALTER TABLE changesets DISABLE TRIGGER changesets_append_only_row;
ALTER TABLE node_versions DISABLE TRIGGER node_versions_append_only_row;
ALTER TABLE edge_versions DISABLE TRIGGER edge_versions_append_only_row;

UPDATE changesets c
SET actor = a.owner_id,
    metadata =
      CASE
        WHEN a.token_name IS NULL THEN COALESCE(c.metadata, '{}'::jsonb)
        WHEN COALESCE(c.metadata, '{}'::jsonb) ? 'token_name' THEN
          (COALESCE(c.metadata, '{}'::jsonb) - 'token_name')
          || CASE
               WHEN COALESCE(c.metadata, '{}'::jsonb) ? 'client_name' THEN '{}'::jsonb
               ELSE jsonb_build_object('client_name', COALESCE(c.metadata, '{}'::jsonb)->>'token_name')
             END
          || jsonb_build_object('token_name', a.token_name)
        ELSE COALESCE(c.metadata, '{}'::jsonb) || jsonb_build_object('token_name', a.token_name)
      END
FROM legacy_agent_users a
WHERE c.actor = a.id;

UPDATE node_versions v
SET actor = a.owner_id
FROM legacy_agent_users a
WHERE v.actor = a.id;

UPDATE edge_versions v
SET actor = a.owner_id
FROM legacy_agent_users a
WHERE v.actor = a.id;

ALTER TABLE edge_versions ENABLE TRIGGER edge_versions_append_only_row;
ALTER TABLE node_versions ENABLE TRIGGER node_versions_append_only_row;
ALTER TABLE changesets ENABLE TRIGGER changesets_append_only_row;

UPDATE nodes n
SET proposer_id = CASE WHEN n.proposer_id = a.id THEN a.owner_id ELSE n.proposer_id END,
    created_by = CASE WHEN n.created_by = a.id THEN a.owner_id ELSE n.created_by END,
    updated_by = CASE WHEN n.updated_by = a.id THEN a.owner_id ELSE n.updated_by END
FROM legacy_agent_users a
WHERE n.proposer_id = a.id OR n.created_by = a.id OR n.updated_by = a.id;

UPDATE edges e
SET created_by = CASE WHEN e.created_by = a.id THEN a.owner_id ELSE e.created_by END,
    updated_by = CASE WHEN e.updated_by = a.id THEN a.owner_id ELSE e.updated_by END
FROM legacy_agent_users a
WHERE e.created_by = a.id OR e.updated_by = a.id;

UPDATE audit_events ae
SET by_user = a.owner_id
FROM legacy_agent_users a
WHERE ae.by_user = a.id;

UPDATE guidance_policies p
SET created_by = CASE WHEN p.created_by = a.id THEN a.owner_id ELSE p.created_by END,
    updated_by = CASE WHEN p.updated_by = a.id THEN a.owner_id ELSE p.updated_by END
FROM legacy_agent_users a
WHERE p.created_by = a.id OR p.updated_by = a.id;

UPDATE node_authoring_policies p
SET created_by = CASE WHEN p.created_by = a.id THEN a.owner_id ELSE p.created_by END,
    updated_by = CASE WHEN p.updated_by = a.id THEN a.owner_id ELSE p.updated_by END
FROM legacy_agent_users a
WHERE p.created_by = a.id OR p.updated_by = a.id;

UPDATE docos d
SET owner_id = a.owner_id
FROM legacy_agent_users a
WHERE d.owner_id = a.id;

UPDATE users u
SET owner_id = a.owner_id,
    data = jsonb_set(COALESCE(u.data, '{}'::jsonb), '{owner_id}', to_jsonb(a.owner_id), true)
FROM legacy_agent_users a
WHERE u.owner_id = a.id;

UPDATE doco_project_tokens t
SET created_by_user_id = a.owner_id
FROM legacy_agent_users a
WHERE t.created_by_user_id = a.id;

UPDATE doco_perspectives p
SET attached_by_user = a.owner_id
FROM legacy_agent_users a
WHERE p.attached_by_user = a.id;

UPDATE chat_conversations c
SET user_id = a.owner_id
FROM legacy_agent_users a
WHERE c.user_id = a.id;

UPDATE chat_attachments ca
SET user_id = a.owner_id
FROM legacy_agent_users a
WHERE ca.user_id = a.id;

UPDATE group_chat_installations i
SET installed_by_user_id = a.owner_id
FROM legacy_agent_users a
WHERE i.installed_by_user_id = a.id;

UPDATE group_chat_channel_connections c
SET created_by_user_id = a.owner_id
FROM legacy_agent_users a
WHERE c.created_by_user_id = a.id;

DELETE FROM group_chat_user_links l
USING legacy_agent_users a
WHERE l.user_id = a.id
  AND EXISTS (
    SELECT 1
    FROM group_chat_user_links existing
    WHERE existing.provider = l.provider
      AND existing.workspace_id = l.workspace_id
      AND existing.chat_user_id = l.chat_user_id
      AND existing.user_id = a.owner_id
  );

UPDATE group_chat_user_links l
SET user_id = a.owner_id
FROM legacy_agent_users a
WHERE l.user_id = a.id;

UPDATE feedback_reports f
SET created_by = CASE WHEN f.created_by = a.id THEN a.owner_id ELSE f.created_by END,
    reviewed_by = CASE WHEN f.reviewed_by = a.id THEN a.owner_id ELSE f.reviewed_by END
FROM legacy_agent_users a
WHERE f.created_by = a.id OR f.reviewed_by = a.id;

DELETE FROM account_grants g
USING legacy_agent_users a
WHERE g.grantor_user_id = a.id OR g.grantee_user_id = a.id;

DELETE FROM doco_users du
USING legacy_agent_users a
WHERE du.user_id = a.id;

DELETE FROM org_users ou
USING legacy_agent_users a
WHERE ou.user_id = a.id;

DELETE FROM users u
USING legacy_agent_users a
WHERE u.id = a.id;
