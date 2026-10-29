#!/usr/bin/env bash
set -euo pipefail
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$task_root"
mkdir -p test/results/search-verification-native
exec 9>test/results/search-native.lock
flock -n 9 || { printf '%s\n' 'Another isolated search test owns the shared runner.' >&2; exit 1; }
test -z "$(ss -H -ltn '( sport = :25440 )')" || { printf '%s\n' 'Test port 25440 is occupied; no process was changed.' >&2; exit 1; }
task_run="search-verification-$(date -u +%Y%m%dT%H%M%SZ)-$$"
task_container="ainvr-$task_run"
task_image=$(docker image inspect --format '{{.Id}}' mongo:7.0)
cleanup() {
  task_status=$?
  trap - EXIT INT TERM
  if [[ "$(docker inspect --format '{{index .Config.Labels "ainvr.test.run"}}' "$task_container" 2>/dev/null || true)" == "$task_run" ]]; then
    docker logs --tail 80 "$task_container" >test/results/search-verification-native/mongo-last.log 2>&1 || true
    docker rm --force --volumes "$task_container" >/dev/null
  fi
  exit "$task_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cmake -S search-service -B out/search-verification-software -DAINVR_SEARCH_WITH_BPU_TEXT=OFF -DAINVR_SEARCH_BUILD_HARDWARE_PROBES=OFF
cmake --build out/search-verification-software --target ainvr_search_verification_test ainvr_search_session_test ainvr_search_http_test ainvr_search_mongo_ping -j2
docker run --detach --name "$task_container" --label "ainvr.test.run=$task_run" \
  --network host --memory 768m --cpus 0.5 --tmpfs /data/db:rw,size=384m --tmpfs /data/configdb:rw,size=8m "$task_image" \
  mongod --bind_ip 127.0.0.1 --port 25440 --wiredTigerCacheSizeGB 0.25 --quiet >/dev/null
task_ready=0
task_deadline=$((SECONDS + 20))
while (( SECONDS < task_deadline )); do
  if timeout 1 out/search-verification-software/ainvr_search_mongo_ping >/dev/null 2>&1; then task_ready=1; break; fi
  sleep 0.2
done
test "$task_ready" -eq 1 || { printf '%s\n' 'Isolated test Mongo did not become ready.' >&2; exit 1; }
timeout 60 env AINVR_SEARCH_TEST_MONGO=1 ctest --test-dir out/search-verification-software \
  --output-on-failure -R '^(search_verification|search_session|search_http)$' | tee test/results/search-verification-native/native-last.log
