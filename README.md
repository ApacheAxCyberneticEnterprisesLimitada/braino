# Braino

Braino is an open knowledge system for durable decisions, rules, evidence, and
their relationships. This repository is the sole upstream for the open product.

This tree contains the supported single-workspace, self-hosted product:

- `@doco/shared` — entity types, identifiers, policies, and URL conventions
- `@doco/plugin-runtime` — versioned manifests and capability contracts for plugins
- `@doco/db` — PostgreSQL schema and source-of-truth storage
- `@doco/host` — workspace, collection, person, and template services
- `@doco/index` — retrieval, ranking, embeddings, and Qdrant integration
- `@doco/web` — first-run setup, owner sign-in, workspace home, collection reader, and record authoring

A release is cut when a version bump merges to main. Each one publishes the
reusable packages above plus `@doco/connector-plugins` as immutable tarball
assets beside the application image. Hosted Braino consumes those assets instead of carrying a second copy of
the core implementation.

The supported deployment is one application image running the web process and
the Braino Times scheduler, one stateless CodeLinker service, one PostgreSQL
source of truth, and one rebuildable Qdrant index. Core authoring, team access,
deterministic search, Braino Times, MCP, generic webhooks, GitHub import, and
operations work without a model provider.

## Self-hosting

```sh
cp .env.example .env
# Fill all four secrets in .env with independent `openssl rand -base64 32` values.
docker compose up -d --build
curl --fail http://localhost:3000/healthz
```

`BRAINO_SETUP_TOKEN` is a per-deployment bootstrap secret, not a default
embedded in the image or a Braino Cloud credential. Generate it yourself—or
have deployment automation generate it—and keep it in the deployment's private
environment; the Docker path above stores it in the host's uncommitted `.env`.
It prevents the first visitor to a publicly reachable, uninitialized instance
from claiming ownership. After the sole workspace is created, first-run setup
is closed and the token cannot initialize another workspace.

Open `http://localhost:3000`, enter `BRAINO_SETUP_TOKEN`, and create the owner and
sole workspace. The application port binds to loopback; the optional Caddy
profile is the supported way to expose Braino publicly. Records
can be captured from a collection page or created, related, transitioned, and
superseded through its compatible `/<collection-handle>/api/changesets.json`
endpoint; the adjacent `api/authoring-contract.json` endpoint describes the
supported operations and shapes.

The owner opens **Admin** for the deployment overview and workspace settings,
including its name, constitution, and Braino Times publication timezone and
public visibility. The scheduler publishes at most one edition per local
calendar day; PostgreSQL keeps every edition, and signed-out readers see only
stories from public collections. The same console is the single path to
people and roles, source connections, webhooks, GitHub sync, and agent/MCP
access. It reports configuration readiness without displaying secret values;
privileged backup, restore, and upgrade commands stay on the host.

Señor Braino and other agents connect directly to the deployment over stateless
MCP. Open **MCP** on the workspace page, copy this instance's `/mcp` URL, then
add it in ChatGPT with **Add custom MCP server** and choose OAuth. The instance
publishes its own protected-resource and authorization-server metadata, registers
public clients dynamically, requires authorization-code PKCE, rotates refresh
tokens, and binds every grant to this exact MCP resource. Its PostgreSQL database
is the only token store: credentials, MCP requests, and workspace records never
pass through Braino production or another installation.

The endpoint serves a stable profile, deterministic briefs and search, record
reads, feedback, and atomic changesets without requiring a model provider. MCP
clients that do not support OAuth can instead create a named personal access
token from the same page. All access tokens are stored only as SHA-256 digests
and remain bound to their creator's live workspace membership.

PostgreSQL and Qdrant use named volumes and are not exposed on host ports. Plain
HTTP on port 3000 is the default. For a public DNS name with automatic HTTPS,
set `DOCO_HOST` and `DOCO_PUBLIC_HOST`, then start with
`docker compose --profile tls up -d --build`.

Workspace owners can create generic incoming webhooks from **Integrations**.
POST `{"operations":[...],"reason":"..."}` to the one-time secret URL and
send a unique `Idempotency-Key` header. Deliveries use the same authoring
policies, history, permissions, and changeset response as Braino's API; retrying
the same key returns the original response without writing twice.

Owners can connect Slack, Notion, and Google Drive from the same page. They are
built-in `source.pull` plugins using the same versioned manifest and capability
protocol that other plugin categories will use. The manifest declares each
plugin's capabilities and network destinations; Braino rejects incompatible or
mismatched definitions before execution. This release does not load arbitrary
third-party code or contact a Braino-operated plugin relay.

Each external source is bound to this Braino workspace, its credential is encrypted with
`DOCO_ENCRYPTION_KEY`, and its read-only records land in a private collection
with ordinary search, history, and audit behavior. For Slack, create a bot
token with `channels:read`, `channels:history`, and `users:read`; only public,
non-shared channels are copied. For Notion, create an internal integration with
read-content access and explicitly share the pages Braino should copy. For Google
Drive, enable the Drive API, create a service-account JSON key, and share the
folders or files with that service account; Braino imports Docs, Sheets, Slides,
and text files while ignoring binary files.

Owners can also connect one GitHub repository from **Integrations** with a
fine-grained personal access token scoped to that repository. Grant read access
to Metadata, Contents, Issues, and Pull requests, plus Webhooks write access. Braino
encrypts the token with `DOCO_ENCRYPTION_KEY`, imports into dedicated GitHub
codebase, issue, and pull-request collections, and records every source change in the
same immutable history. When `DOCO_PUBLIC_HOST` is public HTTPS, Braino registers
a signed repository webhook and refreshes automatically on issue and pull
request and push events; delivery IDs make retries idempotent. **Sync now** remains the
fallback, and unchanged items do not create versions.

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
restore, while the stateless CodeLinker needs no backup. Backups include
deployment configuration and are written with mode `0600`. See
[Operating Braino](docs/operations.md) for the full procedure.

The executable [v0.1 conformance contract](docs/v0.1-conformance.md) covers a
clean Docker boot in under ten minutes, the core product surfaces, and a
destructive backup/restore drill. A release cannot publish until it passes.

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
