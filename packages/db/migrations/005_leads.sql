CREATE TABLE IF NOT EXISTS leads (
  id                 text PRIMARY KEY,
  kind               text NOT NULL CHECK (kind IN ('open_source','managed_services','partner')),
  email              text NOT NULL,
  name               text NOT NULL DEFAULT '',
  company            text NOT NULL DEFAULT '',
  answers            jsonb NOT NULL DEFAULT '{}'::jsonb,
  source             text NOT NULL DEFAULT 'direct',
  status             text NOT NULL,
  status_changed_at  timestamptz,
  status_changed_by  text REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  submitted_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, email),
  CHECK (
    (kind = 'open_source' AND status IN ('waiting','notified')) OR
    (kind = 'managed_services' AND status IN ('new','contacted','client','not_a_fit')) OR
    (kind = 'partner' AND status IN ('applied','accepted','certified','not_a_fit'))
  )
);
CREATE INDEX IF NOT EXISTS leads_kind_created_idx ON leads (kind, created_at DESC);
