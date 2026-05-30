-- 017_agent_telemetry.sql
-- ============================================================
-- Two tables for measuring where Doco spends time:
--
--   1. agent_turn_metrics — one row per Señor Doco reply. Captures
--      bootstrap / history / Anthropic / tool timings plus token
--      counts, so we can ask "where does a turn spend its seconds?"
--      empirically instead of by code reading.
--
--   2. capture_timings — one row per neuron/primitive POST or PATCH.
--      Captures the persist / authoring-primitive / LLM-judge /
--      reindex breakdown plus the `loadDocoFromPostgres` cost so we
--      can validate (or refute) the "incremental reindex reads the
--      whole Doco" hypothesis.
--
-- Both tables are forward-only telemetry: schemas can grow columns
-- later; old rows just carry zeros for the new ones.
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_turn_metrics (
  id                       TEXT PRIMARY KEY,
  conversation_id          TEXT NOT NULL
                              REFERENCES chat_conversations(id) ON DELETE CASCADE,
  collaborator_id          TEXT NOT NULL,
  model                    TEXT NOT NULL,
  started_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  total_ms                 INTEGER NOT NULL,
  bootstrap_ms             INTEGER NOT NULL DEFAULT 0,
  history_load_ms          INTEGER NOT NULL DEFAULT 0,
  first_text_token_ms      INTEGER,
  num_anthropic_calls      INTEGER NOT NULL DEFAULT 0,
  num_tool_calls           INTEGER NOT NULL DEFAULT 0,
  input_tokens             INTEGER NOT NULL DEFAULT 0,
  output_tokens            INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens        INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens    INTEGER NOT NULL DEFAULT 0,
  history_message_count    INTEGER NOT NULL DEFAULT 0,
  attachment_count         INTEGER NOT NULL DEFAULT 0,
  stop_reason              TEXT,
  error                    TEXT,
  -- Per-call detail (Anthropic round trips, tool calls). Free-form so
  -- the schema doesn't churn every time we add a measurement; query
  -- with jsonb operators when needed.
  phases                   JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_agent_turn_metrics_conversation
  ON agent_turn_metrics(conversation_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_turn_metrics_started
  ON agent_turn_metrics(started_at DESC);

CREATE TABLE IF NOT EXISTS capture_timings (
  id                          TEXT PRIMARY KEY,
  doco_id                     TEXT NOT NULL,
  entity_type                 TEXT NOT NULL,
  http_method                 TEXT NOT NULL,
  principal_id                TEXT,
  started_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  total_ms                    INTEGER NOT NULL,
  persist_ms                  INTEGER NOT NULL DEFAULT 0,
  authoring_ms                INTEGER NOT NULL DEFAULT 0,
  judge_ms                    INTEGER NOT NULL DEFAULT 0,
  judge_calls                 INTEGER NOT NULL DEFAULT 0,
  reindex_structural_ms       INTEGER NOT NULL DEFAULT 0,
  reindex_load_ms             INTEGER NOT NULL DEFAULT 0,
  reindex_load_entity_count   INTEGER NOT NULL DEFAULT 0,
  status_code                 INTEGER,
  user_agent                  TEXT,
  error                       TEXT
);

CREATE INDEX IF NOT EXISTS idx_capture_timings_doco_started
  ON capture_timings(doco_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_capture_timings_started
  ON capture_timings(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_capture_timings_entity_type
  ON capture_timings(entity_type, started_at DESC);
