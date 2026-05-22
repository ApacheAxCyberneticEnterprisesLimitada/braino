-- 015_remove_doco_descriptions.sql
-- ============================================================
-- Docos no longer have descriptions. They were stored only in the
-- docos.data JSONB metadata bag, so remove the key from all existing
-- rows.
-- ============================================================

UPDATE docos
   SET data = data - 'description',
       updated_at = now()
 WHERE data ? 'description';
