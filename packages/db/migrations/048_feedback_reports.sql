-- 048_feedback_reports.sql
-- Host-level bug and idea reports submitted from the signed-in app shell.
--
-- These are intentionally not Doco-scoped neurons: they describe the
-- product experience itself, and the mentor review surface needs raw
-- client/server context so reports remain diagnosable after the page
-- has changed.

CREATE TABLE IF NOT EXISTS feedback_reports (
  id                    text PRIMARY KEY,
  report_type           text NOT NULL CHECK (report_type IN ('bug', 'idea')),
  status                text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'archived')),
  title                 text NOT NULL DEFAULT '',
  body                  text NOT NULL DEFAULT '',
  expected              text NOT NULL DEFAULT '',
  actual                text NOT NULL DEFAULT '',
  severity              text NOT NULL DEFAULT '',
  page_url              text NOT NULL DEFAULT '',
  route_path            text NOT NULL DEFAULT '',
  created_by            text REFERENCES collaborators(id) ON DELETE SET NULL,
  created_by_username   text NOT NULL DEFAULT '',
  client_context        jsonb NOT NULL DEFAULT '{}'::jsonb,
  server_context        jsonb NOT NULL DEFAULT '{}'::jsonb,
  data                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  reviewed_at           timestamptz,
  reviewed_by           text REFERENCES collaborators(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS feedback_reports_created_idx
  ON feedback_reports (created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_reports_type_status_idx
  ON feedback_reports (report_type, status, created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_reports_created_by_idx
  ON feedback_reports (created_by, created_at DESC);
