-- 007_perspectives.sql
-- ============================================================
-- Visualization perspectives: user-owned rendering configs that
-- can be attached to a Doco's overview page, like templates but
-- about *how* the graph renders rather than what nodes it accepts.
--
-- Two tables:
--   perspectives           — registry of available perspectives
--                            (builtin + user-created). Sibling
--                            concept to DocoTemplate in
--                            packages/host.
--   doco_perspectives      — many-to-many between docos and
--                            perspectives, with ordering and a
--                            single default per doco.
--
-- Ownership follows the template convention: a plain handle
-- (e.g. "torrenegra") rather than a hard FK to collaborators,
-- so builtins can survive collaborator deletion and templates
-- can ship without depending on the host's collaborator table
-- being populated.
--
-- Seeded built-ins:
--   graph  — current OverviewGraph rendering.
--   list   — sortable list, type-aware tiebreakers.
--   bpmn   — swim-lane BPMN-style render, owner_handle =
--            'torrenegra'.
--
-- After insert, every existing Doco gets {graph, list} attached
-- with graph as default; BPMN is optional and attached by the
-- user from the picker page.
-- ============================================================

CREATE TABLE IF NOT EXISTS perspectives (
  id                      text PRIMARY KEY,                 -- perspective_<slug> for builtins, perspective_<ulid> for user-created
  slug                    text NOT NULL UNIQUE,             -- 'graph' | 'list' | 'bpmn' | user-chosen
  kind                    text NOT NULL CHECK (kind IN ('graph','list','bpmn')),
  name                    text NOT NULL,                    -- display name on the tab
  description             text,
  icon                    text,                             -- single emoji
  owner_handle            text,                             -- denormalized; matches template ownership convention
  owner_collaborator_id   text REFERENCES collaborators(id) ON DELETE SET NULL,
  is_builtin              boolean NOT NULL DEFAULT false,
  config                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS perspectives_owner_handle_idx ON perspectives (owner_handle);
CREATE INDEX IF NOT EXISTS perspectives_kind_idx         ON perspectives (kind);

CREATE TABLE IF NOT EXISTS doco_perspectives (
  doco_id                   text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  perspective_id            text NOT NULL REFERENCES perspectives(id) ON DELETE CASCADE,
  position                  int  NOT NULL DEFAULT 0,
  is_default                boolean NOT NULL DEFAULT false,
  attached_at               timestamptz NOT NULL DEFAULT now(),
  attached_by_collaborator  text REFERENCES collaborators(id) ON DELETE SET NULL,
  PRIMARY KEY (doco_id, perspective_id)
);

CREATE INDEX IF NOT EXISTS doco_perspectives_doco_idx ON doco_perspectives (doco_id, position);

-- At most one default perspective per doco. Partial unique index on
-- (doco_id) WHERE is_default keeps the invariant in the database
-- rather than relying on application code.
CREATE UNIQUE INDEX IF NOT EXISTS doco_perspectives_one_default
  ON doco_perspectives (doco_id) WHERE is_default;

-- ──────────────────────────────────────────────────────────────────
-- Seed built-in perspectives.
-- ──────────────────────────────────────────────────────────────────
INSERT INTO perspectives (id, slug, kind, name, description, icon, owner_handle, is_builtin, config)
VALUES
  ('perspective_graph',
   'graph',
   'graph',
   'Graph',
   'Force-directed overview of neurons and synapses — the original view.',
   '🕸️',
   NULL,
   true,
   '{}'::jsonb),
  ('perspective_list',
   'list',
   'list',
   'List',
   'Sortable list of neurons, with type-aware tiebreakers.',
   '📋',
   NULL,
   true,
   '{"default_sort":"recent_desc"}'::jsonb),
  ('perspective_bpmn',
   'bpmn',
   'bpmn',
   'BPMN',
   'Business process modeling — swim lanes, gateways, and events. Inspired by BPMN.',
   '🏭',
   'torrenegra',
   true,
   '{"lane_axis":"principal"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- ──────────────────────────────────────────────────────────────────
-- Attach the two ship-by-default perspectives to every existing Doco.
-- Graph is default, List is position 1. BPMN stays optional — users
-- add it from the picker page.
-- ──────────────────────────────────────────────────────────────────
INSERT INTO doco_perspectives (doco_id, perspective_id, position, is_default)
SELECT d.id, 'perspective_graph', 0, true
  FROM docos d
ON CONFLICT (doco_id, perspective_id) DO NOTHING;

INSERT INTO doco_perspectives (doco_id, perspective_id, position, is_default)
SELECT d.id, 'perspective_list', 1, false
  FROM docos d
ON CONFLICT (doco_id, perspective_id) DO NOTHING;
