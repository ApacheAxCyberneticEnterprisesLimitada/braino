-- 043_drop_doco_name.sql
--
-- Docos now have one public name: `handle`. Drop the separate
-- human-readable name/display_name storage so there is no schema-level
-- distinction between a Doco's slug and label.

ALTER TABLE docos
  DROP COLUMN IF EXISTS name;

UPDATE docos
   SET data = data - 'display_name' - 'name'
 WHERE data ? 'display_name'
    OR data ? 'name';
