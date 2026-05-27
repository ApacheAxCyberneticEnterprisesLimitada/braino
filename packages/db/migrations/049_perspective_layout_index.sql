CREATE TABLE IF NOT EXISTS perspective_layout_snapshots (
  id text PRIMARY KEY,
  doco_id text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  perspective_kind text NOT NULL,
  layout_version bigint NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'dirty'
    CHECK (status IN ('dirty', 'building', 'ready', 'failed')),
  algorithm text NOT NULL DEFAULT '',
  config_hash text NOT NULL DEFAULT '',
  bounds_min_x double precision,
  bounds_min_y double precision,
  bounds_max_x double precision,
  bounds_max_y double precision,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  dirty_at timestamptz,
  built_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doco_id, perspective_kind)
);

CREATE INDEX IF NOT EXISTS perspective_layout_snapshots_lookup_idx
  ON perspective_layout_snapshots (doco_id, perspective_kind, status);

CREATE TABLE IF NOT EXISTS perspective_layout_nodes (
  snapshot_id text NOT NULL REFERENCES perspective_layout_snapshots(id) ON DELETE CASCADE,
  doco_id text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  perspective_kind text NOT NULL,
  entity_id text NOT NULL,
  entity_type text NOT NULL,
  x double precision NOT NULL,
  y double precision NOT NULL,
  width double precision NOT NULL,
  height double precision NOT NULL,
  z_index integer NOT NULL DEFAULT 0,
  lod_level integer NOT NULL DEFAULT 0,
  cluster_id text,
  layout_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_id, entity_id)
);

CREATE INDEX IF NOT EXISTS perspective_layout_nodes_viewport_idx
  ON perspective_layout_nodes (doco_id, perspective_kind, lod_level, x, y);

CREATE INDEX IF NOT EXISTS perspective_layout_nodes_entity_idx
  ON perspective_layout_nodes (doco_id, entity_id);

CREATE TABLE IF NOT EXISTS perspective_layout_edges (
  snapshot_id text NOT NULL REFERENCES perspective_layout_snapshots(id) ON DELETE CASCADE,
  doco_id text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  perspective_kind text NOT NULL,
  source_id text NOT NULL,
  target_id text NOT NULL,
  synapse_type text NOT NULL,
  min_x double precision,
  min_y double precision,
  max_x double precision,
  max_y double precision,
  path jsonb NOT NULL DEFAULT '{}'::jsonb,
  layout_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_id, source_id, target_id, synapse_type)
);

CREATE INDEX IF NOT EXISTS perspective_layout_edges_viewport_idx
  ON perspective_layout_edges (doco_id, perspective_kind, min_x, min_y, max_x, max_y);

CREATE INDEX IF NOT EXISTS perspective_layout_edges_endpoint_idx
  ON perspective_layout_edges (doco_id, source_id, target_id);

CREATE TABLE IF NOT EXISTS perspective_layout_dirty_scopes (
  doco_id text NOT NULL REFERENCES docos(id) ON DELETE CASCADE,
  perspective_kind text NOT NULL,
  scope_kind text NOT NULL
    CHECK (scope_kind IN ('node', 'edge', 'lane', 'pool', 'subtree', 'viewport', 'global')),
  scope_key text NOT NULL DEFAULT '*',
  changed_entity_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  reason text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doco_id, perspective_kind, scope_kind, scope_key)
);

CREATE INDEX IF NOT EXISTS perspective_layout_dirty_scopes_pending_idx
  ON perspective_layout_dirty_scopes (status, updated_at);
