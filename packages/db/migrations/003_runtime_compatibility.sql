ALTER TABLE passkeys
  ADD COLUMN IF NOT EXISTS rp_id text;

ALTER TABLE group_chat_channels
  ADD COLUMN IF NOT EXISTS history_until timestamptz;

ALTER TABLE feedback_reports
  ADD COLUMN IF NOT EXISTS fixed_emailed_at timestamptz;
