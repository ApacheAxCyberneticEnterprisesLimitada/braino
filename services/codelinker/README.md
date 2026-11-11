# Braino CodeLinker service

The service turns a normalized Python or Scala repository snapshot into a
deterministic file graph. It parses source text with Tree-sitter and returns
symbols plus `IMPORTS`, `REFERENCES`, `CALLS`, `EXTENDS`, and Python
`ROUTES_TO` links.

It also links independently versioned repositories through
`POST /v1/repository-links`. Repository identities and their singular or
plural service aliases are derived from the request; Java client annotations,
configuration endpoints, and exact GitHub repository URLs provide the
evidence. The linker contains no organization-specific service dictionary.

It deliberately does not clone repositories, execute builds, or receive
GitHub credentials. Braino's connector remains responsible for access control
and sends the source files it already ingested.

## API

- `GET /healthz` is public.
- `POST /v1/graphs` requires `Authorization: Bearer $BRAINO_CODELINKER_API_TOKEN`.
- `POST /v1/repository-links` requires the same bearer token.

```json
{
  "language": "scala",
  "files": [
    { "path": "app/Foo.scala", "content": "import app.Bar\nclass Foo extends Bar" },
    { "path": "app/Bar.scala", "content": "class Bar" }
  ]
}
```

The server accepts relative paths only and enforces configurable per-file,
repository, and request-size limits.

```json
{
  "repositories": [
    {
      "id": "example/orders",
      "files": [
        {
          "path": "src/Clients.java",
          "content": "@GrpcChannel(name = \"payment\") PaymentService payment;"
        }
      ]
    },
    { "id": "example/payment", "files": [] }
  ]
}
```

## Local

```sh
cargo test --locked --manifest-path services/codelinker/Cargo.toml
docker build -f services/codelinker/Dockerfile -t braino-codelinker .
docker run --rm -p 8080:8080 \
  -e BRAINO_CODELINKER_API_TOKEN="$(openssl rand -hex 32)" \
  braino-codelinker
```
