#!/usr/bin/env bash

set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"

pnpm run build:packages
pnpm --filter @doco/db exec vitest run \
  src/__tests__/schema-apply-once.test.ts
pnpm --filter @doco/host exec vitest run \
  src/__tests__/single-workspace.real-db.test.ts \
  src/__tests__/workspace-admin.real-db.test.ts \
  src/__tests__/collaborators.real-db.test.ts \
  src/__tests__/changesets.real-db.test.ts \
  src/__tests__/workspace-search.real-db.test.ts \
  src/__tests__/mcp-core.real-db.test.ts \
  src/__tests__/incoming-webhooks.real-db.test.ts \
  src/__tests__/github-connections.real-db.test.ts
pnpm --filter @doco/web exec vitest run \
  app/lib/__tests__/self-hosted-compose.test.ts \
  app/design-language.test.ts \
  app/admin-console.test.ts

if [[ "${DOCO_CONFORMANCE_SKIP_DOCKER:-}" == "1" ]]; then
  echo "Braino v0.1 logic conformance passed; Docker proof skipped by request."
  exit 0
fi

command -v docker >/dev/null || {
  echo "conformance: Docker is required" >&2
  exit 1
}
docker compose version >/dev/null

started_at=$(date +%s)
runtime=$(mktemp -d "${TMPDIR:-/tmp}/doco-conformance.XXXXXX")
project="doco-conformance-$$"
image="doco:conformance-$$"
codelinker_image="braino-codelinker:conformance-$$"
port=${DOCO_CONFORMANCE_PORT:-3210}

cleanup() {
  if [[ -d "$runtime" ]]; then
    (
      cd "$runtime"
      docker compose down -v --remove-orphans >/dev/null 2>&1 || true
    )
    docker image rm "$image" >/dev/null 2>&1 || true
    docker image rm "$codelinker_image" >/dev/null 2>&1 || true
    find "$runtime" -mindepth 1 -delete
    rmdir "$runtime"
  fi
}
trap cleanup EXIT

git archive --format=tar HEAD | tar -xf - -C "$runtime"
cd "$runtime"

export COMPOSE_PROJECT_NAME="$project"
export DOCO_IMAGE="$image"
export BRAINO_CODELINKER_IMAGE="$codelinker_image"
export DOCO_POSTGRES_PASSWORD="conformance-postgres-$project"
export DOCO_ENCRYPTION_KEY="conformance-encryption-key-$project-000000000000"
export BRAINO_SETUP_TOKEN="conformance-setup-token-$project-000000000000000"
export BRAINO_CODELINKER_API_TOKEN="conformance-codelinker-token-$project-000000000000"
export DOCO_HTTP_PORT="$port"
export DOCO_PUBLIC_HOST="http://localhost:$port"

docker compose build app codelinker
if [[ "${DOCO_CONFORMANCE_PRUNE_BUILD_CACHE:-}" == "1" ]]; then
  docker builder prune --force >/dev/null
fi
docker compose up -d --wait
origin="http://localhost:$port"
curl --fail --silent --show-error "$origin/healthz" >/dev/null
docker compose exec -T app node --input-type=module -e '
  const response = await fetch("http://codelinker:8080/healthz");
  if (!response.ok) process.exit(1);
'

cookies="$runtime/cookies.txt"
curl --fail --silent --show-error -c "$cookies" "$origin/" >/dev/null
setup_status=$(curl --silent --show-error -o "$runtime/setup-response" -w '%{http_code}' \
  -b "$cookies" -c "$cookies" -X POST "$origin/?index" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'intent=setup' \
  --data-urlencode 'workspace_name=Conformance Workspace' \
  --data-urlencode 'workspace_handle=conformance' \
  --data-urlencode 'owner_name=Conformance Owner' \
  --data-urlencode 'owner_username=conformance-owner' \
  --data-urlencode 'owner_email=owner@conformance.invalid' \
  --data-urlencode "setup_token=$BRAINO_SETUP_TOKEN" \
  --data-urlencode 'password=conformance-owner-password' \
  --data-urlencode 'password_confirmation=conformance-owner-password')
[[ "$setup_status" == "302" || "$setup_status" == "303" ]]

curl --fail --silent --show-error -b "$cookies" "$origin/" >"$runtime/dashboard"
grep -q 'Conformance Workspace' "$runtime/dashboard"
curl --fail --silent --show-error -b "$cookies" "$origin/admin" >"$runtime/admin"
grep -q 'Workspace administration' "$runtime/admin"
second_setup_status=$(curl --silent --show-error -o "$runtime/second-setup-response" \
  -w '%{http_code}' -b "$cookies" -X POST "$origin/?index" \
  -H 'Content-Type: application/x-www-form-urlencoded' --data-urlencode 'intent=setup')
[[ "$second_setup_status" == "409" ]]

curl --fail --silent --show-error -b "$cookies" \
  "$origin/api/v1/collections.json" >"$runtime/collections.json"
collection_handle=$(node -e '
  const fs = require("node:fs");
  const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const collection = body.collections.find((entry) => entry.handle.endsWith("-glossary"));
  if (!collection) process.exit(1);
  process.stdout.write(collection.handle);
' "$runtime/collections.json")
curl --fail --silent --show-error -b "$cookies" \
  -H 'Content-Type: application/json' \
  --data '{"operations":[{"op":"create","node_type":"reference","body":{"lifecycle":"drafting","prose":"Braino v0.1 conformance record"}}],"reason":"v0.1 clean-boot proof"}' \
  "$origin/$collection_handle/api/changesets.json" >"$runtime/changeset.json"
grep -q '"ok":true' "$runtime/changeset.json"
curl --fail --silent --show-error -b "$cookies" \
  "$origin/api/v1/search.json?q=v0.1%20conformance" >"$runtime/search.json"
grep -q 'Braino v0.1 conformance record' "$runtime/search.json"
docker compose exec -T app node --input-type=module -e '
  const response = await fetch("http://qdrant:6333/collections/doco_records");
  if (!response.ok) process.exit(1);
  const body = await response.json();
  if (Number(body.result?.points_count ?? 0) < 1) process.exit(1);
'

./doco doctor >/dev/null
./doco backup "$runtime/conformance-backup.tar.gz" >/dev/null
docker compose exec -T postgres psql --username doco --dbname doco \
  -c "DELETE FROM nodes WHERE prose = 'Braino v0.1 conformance record'" >/dev/null
deleted=$(docker compose exec -T postgres psql --username doco --dbname doco --tuples-only --no-align \
  -c "SELECT count(*) FROM nodes WHERE prose = 'Braino v0.1 conformance record'")
[[ "$deleted" == "0" ]]
./doco restore "$runtime/conformance-backup.tar.gz" --force >/dev/null
restored=$(docker compose exec -T postgres psql --username doco --dbname doco --tuples-only --no-align \
  -c "SELECT count(*) FROM nodes WHERE prose = 'Braino v0.1 conformance record'")
[[ "$restored" == "1" ]]
curl --fail --silent --show-error "$origin/healthz" >/dev/null

elapsed=$(( $(date +%s) - started_at ))
if (( elapsed >= 600 )); then
  echo "conformance: clean-machine proof took ${elapsed}s; the v0.1 limit is under 600s" >&2
  exit 1
fi
echo "Braino v0.1 conformance passed in ${elapsed}s."
