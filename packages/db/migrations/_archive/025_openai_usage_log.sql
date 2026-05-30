-- 025_openai_usage_log.sql
-- ============================================================
-- Per-call usage log for OpenAI embedding requests. Lets the admin
-- dashboard show "how many embeddings did we burn today, how many
-- chars did they total" alongside the Anthropic side already
-- captured by `agent_turn_metrics`.
--
-- One row per `OpenAIEmbeddingProvider.embed(texts[])` call. The
-- batch size lives in `input_count`; the per-string lengths sum
-- into `total_chars` (a cheap stand-in for token count — OpenAI's
-- embedding API doesn't return usage in the body, and chars/4 is a
-- reasonable approximation for English text).
-- ============================================================

CREATE TABLE IF NOT EXISTS openai_usage_log (
  id            TEXT PRIMARY KEY,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  model         TEXT NOT NULL,
  input_count   INTEGER NOT NULL DEFAULT 0,
  total_chars   INTEGER NOT NULL DEFAULT 0,
  request_ms    INTEGER,
  ok            BOOLEAN NOT NULL DEFAULT true,
  error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_openai_usage_log_occurred
  ON openai_usage_log(occurred_at DESC);
