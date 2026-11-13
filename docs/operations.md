# Operating Braino

PostgreSQL is Braino's source of truth. Qdrant is a rebuildable search projection,
CodeLinker is a stateless parser, and the plugin host is a stateless Wasmtime
sandbox. The supported Compose deployment keeps
only PostgreSQL and Qdrant in named volumes and provides one command for
validation, backup, restore, and upgrades.

## Preflight

Copy `.env.example` to `.env`, generate independent secrets, then validate the
resolved Compose configuration:

```sh
./doco doctor
```

## Backup

```sh
./doco backup
# Or choose the archive path:
./doco backup /secure/backups/doco-2026-11-08.tar.gz
```

The archive contains a custom-format PostgreSQL dump, an image/version
manifest, and `.env` when it exists. It is created with mode `0600` because the
configuration contains credentials. Store the archive encrypted and off-host.
Qdrant is deliberately not backed up: PostgreSQL can rebuild it.

## Restore

Restore into the checkout for the release you want to run:

```sh
./doco restore /secure/backups/doco-2026-11-08.tar.gz
```

Restore stops the application and its stateless services, replaces the PostgreSQL contents, clears the
rebuildable Qdrant projection, and starts the stack only after the database
restore succeeds. If the archive's `.env` differs from the local file, restore
refuses to continue. Review both files, then use `--force` to replace the local
configuration; the previous file is retained as `.env.before-restore.<time>`.

## Upgrade

Set `DOCO_IMAGE`, `BRAINO_CODELINKER_IMAGE`, and `BRAINO_PLUGIN_HOST_IMAGE` in `.env` to the exact,
matching release you intend to run, then:

```sh
./doco upgrade
```

Upgrade validates the configuration, creates a pre-upgrade backup, pulls the
configured images, stops the old application, applies each pending database
migration exactly once, and only then starts the new application. A failed
migration rolls back and leaves the application stopped rather than serving
code against the wrong database shape.

Each release, cut when a version bump merges to main and tagged `v<version>`,
publishes signed, SBOM-attested Linux AMD64 and ARM64 images at
`ghcr.io/brainoinc/braino`, `ghcr.io/brainoinc/braino-codelinker`, and
`ghcr.io/brainoinc/braino-plugin-host`.
