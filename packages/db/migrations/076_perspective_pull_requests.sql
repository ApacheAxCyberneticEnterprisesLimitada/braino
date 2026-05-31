-- 076_perspective_pull_requests.sql — seed the built-in "Pull requests"
-- visualization perspective.
--
-- The Pull requests perspective renders a Doco's imported GitHub pull
-- requests (stored as `reference` nodes whose locator is the PR URL),
-- grouped by lifecycle: merged (asserted), open (drafting), and closed
-- (retired). It ships as a built-in row alongside graph/list/bpmn/etc.
--
-- Two steps, forward-only:
--   1. Widen the perspectives.kind CHECK allow-list to include the new
--      'pull-requests' kind. The baseline CHECK in schema.sql is unnamed,
--      so Postgres auto-named it `perspectives_kind_check`. Drop and re-add
--      with the widened allow-list (mirrors migration 067). On a DB whose
--      baseline already includes 'pull-requests' (fresh installs apply the
--      updated schema.sql first) this is a harmless re-statement.
--   2. INSERT the built-in row. ON CONFLICT DO NOTHING so it is idempotent
--      and coexists with the schema.sql seed.

ALTER TABLE perspectives DROP CONSTRAINT IF EXISTS perspectives_kind_check;
ALTER TABLE perspectives
  ADD CONSTRAINT perspectives_kind_check
  CHECK (kind IN ('graph','list','bpmn','org-tree','sla','approval','glossary','pull-requests'));

INSERT INTO perspectives (id, slug, kind, name, description, icon, owner_handle, is_builtin, config) VALUES
  ('perspective_pull_requests','pull-requests','pull-requests','Pull requests','Imported GitHub pull requests, grouped by lifecycle — merged, open, and closed.','🔀',NULL,true,'{}'::jsonb)
ON CONFLICT (id) DO NOTHING;
