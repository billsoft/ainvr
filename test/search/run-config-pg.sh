#!/usr/bin/env bash
# Isolated parameter-store tests only; never connects to the production PG.
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
tests=(src/test/searchRuntimePg.test.ts src/test/searchJobsPg.test.ts src/test/searchIndexShardsPg.test.ts src/test/searchDefaultMigrationPg.test.ts src/test/searchRefreshPg.test.ts src/test/searchIndexRoutes.test.ts)
seed=true
if (( $# )); then
  (( $# <= 16 )) || { echo 'At most 16 isolated PG test files may be selected.' >&2; exit 64; }
  tests=("$@");seed=false
  for selected in "${tests[@]}"; do
    [[ $selected =~ ^src/test/search[A-Za-z0-9]+Pg\.test\.ts$ && -f "$root/srs-web-console/backend/$selected" ]] || { echo 'Select existing search*Pg.test.ts files only.' >&2; exit 64; }
  done
fi
mkdir -p "$root/test/results"
exec 9>"$root/test/results/search-config-pg.lock"
flock -n 9 || { echo 'Another isolated search PG test owns port 25439.' >&2; exit 1; }
test -z "$(ss -H -ltn '( sport = :25439 )')" || { echo 'Isolated PG port is already occupied; no process was changed.' >&2; exit 1; }
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
AINVR_SEARCH_TEST_PG=1 npm run test:run -- "${tests[@]}"
if [[ $seed == true ]]; then
  AINVR_SEARCH_TEST_PG=1 /opt/ainvr/node-v24.20.0-linux-arm64/bin/node --test "$root/test/search/search-seed-migration-proof.test.mjs"
fi
