-- 047_group_chat_integrations.sql
--
-- Host-level group-chat installations and channel-default access.
-- Installations are provider/workspace scoped; channel connections
-- point to either an org or a Doco and are capped by the Doco user's
-- personal role at save time in the web layer.

CREATE TABLE IF NOT EXISTS group_chat_installations (
  id                              text PRIMARY KEY,
  provider                        text NOT NULL CHECK (provider IN ('slack', 'google-chat', 'discord', 'other')),
  workspace_id                    text NOT NULL,
  workspace_name                  text NOT NULL DEFAULT '',
  bot_user_id                     text,
  bot_access_token                text,
  bot_scope                       text[] NOT NULL DEFAULT ARRAY[]::text[],
  installed_by_chat_user_id       text,
  installed_by_collaborator_id    text REFERENCES collaborators(id) ON DELETE SET NULL,
  data                            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, workspace_id)
);

CREATE INDEX IF NOT EXISTS group_chat_installations_provider_idx
  ON group_chat_installations (provider, workspace_name);

CREATE TABLE IF NOT EXISTS group_chat_channel_connections (
  id                              text PRIMARY KEY,
  provider                        text NOT NULL CHECK (provider IN ('slack', 'google-chat', 'discord', 'other')),
  workspace_id                    text NOT NULL,
  channel_id                      text NOT NULL,
  channel_name                    text NOT NULL DEFAULT '',
  target_level                    text NOT NULL CHECK (target_level IN ('org', 'doco')),
  target_id                       text NOT NULL,
  role                            text NOT NULL CHECK (role IN ('owner', 'approver', 'author', 'reader')),
  created_by_collaborator_id      text REFERENCES collaborators(id) ON DELETE SET NULL,
  data                            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, workspace_id, channel_id, target_level, target_id)
);

CREATE INDEX IF NOT EXISTS group_chat_channel_connections_lookup_idx
  ON group_chat_channel_connections (provider, workspace_id, channel_id);

CREATE INDEX IF NOT EXISTS group_chat_channel_connections_target_idx
  ON group_chat_channel_connections (target_level, target_id);

CREATE TABLE IF NOT EXISTS group_chat_user_links (
  id                              text PRIMARY KEY,
  provider                        text NOT NULL CHECK (provider IN ('slack', 'google-chat', 'discord', 'other')),
  workspace_id                    text NOT NULL,
  chat_user_id                    text NOT NULL,
  collaborator_id                 text NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
  data                            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, workspace_id, chat_user_id, collaborator_id)
);

CREATE INDEX IF NOT EXISTS group_chat_user_links_collaborator_idx
  ON group_chat_user_links (collaborator_id);
