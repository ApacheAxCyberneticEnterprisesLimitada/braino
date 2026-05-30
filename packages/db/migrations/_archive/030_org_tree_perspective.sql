-- 030_org_tree_perspective.sql
-- ============================================================
-- Add the `org-tree` perspective kind and seed the built-in
-- perspective row used by the `org-chart` Doco template.
--
-- The `org-tree` perspective renders a Doco as an organizational
-- chart — Principals as nodes, `reports_to` synapses as edges,
-- with the person-vs-agent distinction shown by icon (👤 vs 🤖).
-- No dedicated renderer ships in this migration; the dispatch in
-- $docoHandle._index.tsx falls through to the default graph
-- renderer for unknown kinds, so an org-chart Doco renders today
-- and a richer renderer can land later without a data migration.
--
-- Pre-change: the perspectives.kind CHECK constraint allowed
-- ('graph','list','bpmn') only. Inserting an `org-tree` row
-- would trip the check.
--
-- Post-change:
--   * `perspectives.kind` CHECK accepts ('graph','list','bpmn','org-tree').
--   * One built-in `perspective_org_tree` row exists, owned by
--     the framework (owner_handle = NULL, is_builtin = true).
--   * NOT attached to any existing Doco — the `org-chart` template
--     attaches it on Doco creation; users of other templates can
--     opt in via the perspectives picker.
-- ============================================================

-- 1. Replace the CHECK constraint with one that also accepts org-tree.
ALTER TABLE perspectives DROP CONSTRAINT IF EXISTS perspectives_kind_check;
ALTER TABLE perspectives
  ADD CONSTRAINT perspectives_kind_check
  CHECK (kind IN ('graph', 'list', 'bpmn', 'org-tree'));

-- 2. Seed the built-in. ON CONFLICT keeps re-runs safe.
INSERT INTO perspectives (id, slug, kind, name, description, icon, owner_handle, is_builtin, config)
VALUES
  ('perspective_org_tree',
   'org-tree',
   'org-tree',
   'Org Tree',
   'Organizational chart — Principals as members, `reports_to` synapses as reporting lines, with person vs AI agent shown by icon.',
   '🏢',
   NULL,
   true,
   '{"root_synapse":"reports_to","icon_by_member_kind":true,"person_icon":"👤","agent_icon":"🤖"}'::jsonb)
ON CONFLICT (id) DO NOTHING;
