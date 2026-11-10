ALTER TABLE users
  ADD COLUMN IF NOT EXISTS nps_emails boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS nps_surveys (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asked_at     timestamptz NOT NULL DEFAULT now(),
  emailed_at   timestamptz,
  snoozed_at   timestamptz,
  score        integer CHECK (score BETWEEN 0 AND 10),
  comment      text NOT NULL DEFAULT '',
  via          text CHECK (via IN ('app','email')),
  answered_at  timestamptz
);

CREATE INDEX IF NOT EXISTS nps_surveys_user_idx
  ON nps_surveys (user_id, asked_at DESC);
CREATE INDEX IF NOT EXISTS nps_surveys_answered_idx
  ON nps_surveys (answered_at DESC) WHERE answered_at IS NOT NULL;
