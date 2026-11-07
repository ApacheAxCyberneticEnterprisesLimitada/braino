# Doco

Doco is an open knowledge system for durable decisions, rules, evidence, and
their relationships. This repository is the sole upstream for the open product.

The extraction from Doco Cloud is in progress. The current tree contains the
foundational data, domain, and retrieval packages with their original history:

- `@doco/shared` — entity types, identifiers, policies, and URL conventions
- `@doco/db` — PostgreSQL schema and source-of-truth storage
- `@doco/host` — workspace, collection, person, and template services
- `@doco/index` — retrieval, ranking, embeddings, and Qdrant integration

The target is a complete single-workspace product that boots from a Docker image
and Compose file. Until the web runtime lands, this repository is a migration
foundation rather than a self-hostable release.

## Development

Requirements: Node.js 22+, pnpm 10.33.2, and Git.

```sh
pnpm install
pnpm verify
```

Development follows trunk-based delivery: make a short-lived branch, open a PR
against `main`, keep the required checks green, and squash-merge it promptly.

## License

Source code in this repository is available under the Mozilla Public License
2.0. See [LICENSE](LICENSE).
