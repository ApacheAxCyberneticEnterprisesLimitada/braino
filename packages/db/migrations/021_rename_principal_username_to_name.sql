-- Rename the principals "username" column to "name".
--
-- Pre-migration-005, principals doubled as the OAuth identity layer
-- and "username" literally meant a GitHub login. Post-migration-005
-- (decision_01KS69M2JEDA0ND9YYS2D2T17P), collaborators carry OAuth
-- identity and principals are role-personas — the slug-shaped label
-- on this table is the role name ("cook", "customer-service-rep"),
-- not a username. Rename the column so writers (Señor Doco, the
-- public POST endpoint, agent prompts) can use the natural field.
--
-- Alpha: no back-compat shim on the POST body. Old `username` callers
-- get a 400 and migrate to `name`.

DO $rename_principal_username_to_name$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'principals' AND column_name = 'username'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'principals' AND column_name = 'name'
  ) THEN
    ALTER TABLE principals RENAME COLUMN username TO name;
  END IF;

  -- The per-Doco unique constraint added by migration 020 still
  -- references the old column name. Rename it for clarity; this is a
  -- pure metadata change.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'principals_doco_username_key'
  ) THEN
    ALTER TABLE principals
      RENAME CONSTRAINT principals_doco_username_key TO principals_doco_name_key;
  END IF;
END
$rename_principal_username_to_name$;
