# Schema migrations

New schema changes go here, not into `src/schema.sql`. The baseline
`schema.sql` is applied first on every startup (idempotent), then
`applyMigrations()` runs each pending file in this directory in
numerical order and records the id in `applied_migrations`.

## File naming

`NNN_short_name.sql`, e.g. `001_principal_type_person.sql`. The `NNN`
prefix is what gets stored in `applied_migrations.id` (without the
`.sql` extension), so it must be unique. Use three digits; pad with
leading zeros.

## Migration contents

- Wrap multi-statement migrations in transactions implicitly — the
  runner already opens BEGIN/COMMIT around each file.
- Don't reference `applied_migrations` from inside a migration.
- If the migration needs to be safe to re-run (e.g. picks up legacy
  state on already-migrated DBs), use `IF NOT EXISTS` / `IF EXISTS`
  guards. Otherwise the runner's one-shot behavior is enough.
- Forward-only: there are no `down` migrations. Roll forward instead.
