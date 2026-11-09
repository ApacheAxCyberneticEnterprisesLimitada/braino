# Database migrations

`src/schema.sql` is the current baseline used only for a new database. Every
schema change must update that baseline and add the next numbered SQL file in
this directory for existing installations.

Migration files are immutable after release. The runtime records each checksum
in `schema_migrations` and refuses to start when an applied file changes or the
database is newer than the application image. Keep migrations transactional;
the startup runner applies all pending files in one transaction before the web
server accepts traffic.
