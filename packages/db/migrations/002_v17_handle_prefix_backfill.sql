-- v17 (2026-05-20): retroactively prefix legacy Doco handles with their
-- org handle (decision_01KS3DWZBNFJ8GG2S0VAMGJ0QQ — handles are flat
-- `/<org-handle>-<suffix>/` URLs).
--
-- v15 added the org_id pointer + minted personal orgs, but did NOT
-- rename existing Docos to match the new convention. Result: docos
-- created before v15 still have bare handles like `meta-doco` or
-- `test19g`. This migration walks every Doco where the handle isn't
-- already prefixed and renames it to `<org_handle>-<old_handle>`,
-- auto-suffixing on collision.
--
-- Side effects:
-- - External links to `/meta-doco/...` BREAK. Callers must update.
--   The .doco/connections.md pointer file in this repo already
--   expected this rename.
-- - raw_yaml.handle is updated in lockstep with the docos.handle
--   column.
--
-- Idempotent: gates on doco_meta.v17_handle_prefix_backfill so the
-- migration is safe on databases that previously ran the old schema.sql
-- convergence block.
DO $v17_handle_prefix$
DECLARE
  rec record;
  new_handle text;
  final_handle text;
  n integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM doco_meta WHERE key = 'v17_handle_prefix_backfill' AND value = 'done'
  ) THEN
    RETURN;
  END IF;

  FOR rec IN
    SELECT d.id, d.handle AS old_handle, d.raw_yaml, o.handle AS org_handle
      FROM docos d
      JOIN organizations o ON o.id = d.org_id
     WHERE o.handle IS NOT NULL
       AND o.handle <> ''
       AND d.handle NOT LIKE o.handle || '-%'
       AND d.handle <> o.handle
  LOOP
    new_handle := rec.org_handle || '-' || rec.old_handle;
    n := 1;
    final_handle := new_handle;
    WHILE EXISTS (SELECT 1 FROM docos WHERE handle = final_handle AND id <> rec.id) LOOP
      n := n + 1;
      final_handle := new_handle || '-' || n;
      IF n > 999 THEN
        RAISE EXCEPTION 'v17 auto-suffix exhausted for %', new_handle;
      END IF;
    END LOOP;

    UPDATE docos
       SET handle = final_handle,
           raw_yaml = jsonb_set(rec.raw_yaml::jsonb, '{handle}', to_jsonb(final_handle), false)::text,
           updated_at = now()
     WHERE id = rec.id;

    RAISE NOTICE 'v17 rename: % → %', rec.old_handle, final_handle;
  END LOOP;

  INSERT INTO doco_meta (key, value) VALUES ('v17_handle_prefix_backfill', 'done')
    ON CONFLICT (key) DO UPDATE SET value = 'done';
END
$v17_handle_prefix$;
