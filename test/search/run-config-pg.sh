#!/usr/bin/env bash
# Isolated parameter-store tests only; never connects to the production PG.
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
owner="ainvr-search-config-test-$$"
container=''
cleanup() {
  if [[ -n "$container" ]] && [[ "$(docker inspect -f '{{index .Config.Labels "ainvr.search.test"}}' "$container" 2>/dev/null || true)" == "$owner" ]]; then
    docker rm -f "$container" >/dev/null
  fi
}
trap cleanup EXIT
container=$(docker run --rm -d --name "$owner" --label "ainvr.search.test=$owner" \
  --network host --tmpfs /var/lib/postgresql/data:rw,nosuid,size=268435456 \
  -e POSTGRES_USER=alarm_test -e POSTGRES_DB=alarm_test -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine \
  postgres -p 25439 -c listen_addresses=127.0.0.1)
ready=false
for attempt in $(seq 1 30); do
  if docker exec "$container" pg_isready -p 25439 -U alarm_test -d alarm_test >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then echo 'Isolated PG did not become ready' >&2; exit 1; fi
cd -- "$root/srs-web-console/backend"
AINVR_SEARCH_TEST_PG=1 npm run test:run -- src/test/searchRuntimePg.test.ts src/test/searchJobsPg.test.ts
