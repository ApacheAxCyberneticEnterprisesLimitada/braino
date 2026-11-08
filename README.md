# Doco

Doco is an open knowledge system for durable decisions, rules, evidence, and
their relationships. This repository is the sole upstream for the open product.

This tree contains the supported single-workspace, self-hosted product:

- `@doco/shared` — entity types, identifiers, policies, and URL conventions
- `@doco/db` — PostgreSQL schema and source-of-truth storage
- `@doco/host` — workspace, collection, person, and template services
- `@doco/index` — retrieval, ranking, embeddings, and Qdrant integration
- `@doco/web` — first-run setup, owner sign-in, workspace home, collection reader, and record authoring

The supported deployment is one application, one PostgreSQL source of truth,
and one rebuildable Qdrant index. Core authoring, team access, deterministic
search, MCP, generic webhooks, GitHub import, and operations work without a
model provider.

## Self-hosting

```sh
cp .env.example .env
# Fill both secrets in .env with independent `openssl rand -base64 32` values.
docker compose up -d --build
curl --fail http://localhost:3000/healthz
```

Open `http://localhost:3000` and create the owner and sole workspace. Records
can be captured from a collection page or created, related, transitioned, and
superseded through its compatible `/<collection-handle>/api/changesets.json`
endpoint; the adjacent `api/authoring-contract.json` endpoint describes the
supported operations and shapes.

Agents can connect over stateless MCP. Open **MCP** on the workspace page,
create a named token, and copy the generated client configuration. The `/mcp`
endpoint serves deterministic briefs and search, record reads, feedback, and atomic
changesets without requiring a model provider; tokens are stored only as
SHA-256 digests and remain bound to their creator's live workspace membership.

PostgreSQL and Qdrant use named volumes and are not exposed on host ports. Plain
HTTP on port 3000 is the default. For a public DNS name with automatic HTTPS,
set `DOCO_HOST` and `DOCO_PUBLIC_HOST`, then start with
`docker compose --profile tls up -d --build`.

Workspace owners can create generic incoming webhooks from **Integrations**.
POST `{"operations":[...],"reason":"..."}` to the one-time secret URL and
send a unique `Idempotency-Key` header. Deliveries use the same authoring
policies, history, permissions, and changeset response as Doco's API; retrying
the same key returns the original response without writing twice.

Owners can also connect one GitHub repository from **Integrations** with a
fine-grained personal access token scoped to that repository. Grant read access
to Metadata, Issues, and Pull requests. Doco encrypts the token with
`DOCO_ENCRYPTION_KEY`, imports into dedicated GitHub issues and pull-request
collections, and records every source change in the same immutable history.
Use **Sync now** to refresh the mirror; unchanged items do not create versions.

## Operations

The supported deployment includes preflight, backup, restore, and controlled
upgrade commands:

```sh
./doco doctor
./doco backup
./doco restore backups/doco-2026-11-08.tar.gz
./doco upgrade
```

PostgreSQL is the source of truth; Qdrant is cleared and rebuilt after a
restore. Backups include deployment configuration and are written with mode
`0600`. See [Operating Doco](docs/operations.md) for the full procedure.

The executable [v0.1 conformance contract](docs/v0.1-conformance.md) covers a
clean Docker boot in under ten minutes, the core product surfaces, and a
destructive backup/restore drill. Version-tag releases cannot publish until it
passes.

## Development

Requirements: Node.js 22+, pnpm 10.33.2, and Git.

```sh
pnpm install
pnpm verify
```

Development changes land through focused pull requests with the required checks
green and are squash-merged into `main`.

## License

Source code in this repository is available under the Mozilla Public License
2.0. See [LICENSE](LICENSE).
