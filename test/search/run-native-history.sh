#!/usr/bin/env bash
set -euo pipefail
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$task_root"
test -f search-service/CMakeLists.txt
mkdir -p test/results
exec 9>test/results/search-native.lock
flock -n 9 || { printf '%s\n' 'Another native search test owns the shared build and Mongo runner.' >&2; exit 1; }
test -z "$(ss -H -ltn '( sport = :25440 )')" || { printf '%s\n' 'Isolated test port 25440 is already occupied; no process was changed.' >&2; exit 1; }
task_run="search-history-$(date -u +%Y%m%dT%H%M%SZ)-$$"
task_container="ainvr-$task_run"
task_image=$(docker image inspect --format '{{.Id}}' mongo:7.0)
mkdir -p test/results/search-history
cleanup() {
  task_status=$?
  trap - EXIT INT TERM
  if [[ "$(docker inspect --format '{{index .Config.Labels "ainvr.test.run"}}' "$task_container" 2>/dev/null || true)" == "$task_run" ]]; then
    docker logs --tail 80 "$task_container" >test/results/search-history/mongo-last.log 2>&1 || true
    # This container and its anonymous data volumes were created only here.
    docker rm --force --volumes "$task_container" >/dev/null
  fi
  exit "$task_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cmake -S search-service -B test/build/search-foundation
cmake --build test/build/search-foundation -j2
docker run --detach --name "$task_container" --label "ainvr.test.run=$task_run" \
  --network host --memory 512m --cpus 0.5 "$task_image" \
  mongod --bind_ip 127.0.0.1 --port 25440 --wiredTigerCacheSizeGB 0.25 --quiet >/dev/null
task_ready=0
task_deadline=$((SECONDS + 20))
while (( SECONDS < task_deadline )); do
  if timeout 2 docker exec "$task_container" mongosh --quiet 'mongodb://127.0.0.1:25440/?serverSelectionTimeoutMS=200' \
    --eval 'quit(db.runCommand({ping:1}).ok ? 0 : 1)' >/dev/null 2>&1; then task_ready=1; break; fi
  sleep 0.2
done
test "$task_ready" -eq 1 || { printf '%s\n' 'Isolated test Mongo did not become ready.' >&2; exit 1; }
timeout 60 env AINVR_SEARCH_TEST_MONGO=1 ctest --test-dir test/build/search-foundation \
  --output-on-failure | tee test/results/search-history/native-last.log
