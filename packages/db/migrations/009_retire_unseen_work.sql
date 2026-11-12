-- The alerts about pull requests a workspace couldn't see were removed, and
-- their state with them: the block on a GitHub integration does their job
-- (Alexander, 2026-11-12, "Stop alerts for PRs already seen via GitHub").
DROP TABLE IF EXISTS unseen_work_authors;
DROP TABLE IF EXISTS unseen_work_alerts;
