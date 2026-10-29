#!/usr/bin/env bash
set -euo pipefail
task_source=test/search/source_writer_mongo_test.cpp
task_binary=test/build/search-writer-policy/mongo
case "${1:-}" in
  '') test "$#" -eq 0 || { echo 'Usage: run-source-writer-mongo.sh [--runtime]' >&2; exit 2; } ;;
  --runtime) test "$#" -eq 1 || { echo 'Usage: run-source-writer-mongo.sh [--runtime]' >&2; exit 2; }
    task_source=test/search/source_ingestion_runtime_mongo_test.cpp
    task_binary=test/build/search-writer-policy/runtime ;;
  *) echo 'Usage: run-source-writer-mongo.sh [--runtime]' >&2; exit 2 ;;
esac
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$task_root"
mkdir -p test/results test/build/search-writer-policy
exec 9>test/results/search-native.lock
flock -n 9 || { echo 'Native software test lock is occupied.' >&2; exit 1; }
test -z "$(ss -H -ltn '( sport = :25440 )')" || { echo 'Isolated Mongo port occupied; no process changed.' >&2; exit 1; }
task_run="source-writer-$(date -u +%Y%m%dT%H%M%SZ)-$$"
task_container="ainvr-$task_run"
task_image=$(docker image inspect --format '{{.Id}}' mongo:7.0)
cleanup() {
  task_status=$?
  trap - EXIT INT TERM
  if [[ "$(docker inspect --format '{{index .Config.Labels "ainvr.test.run"}}' "$task_container" 2>/dev/null || true)" == "$task_run" ]]; then
    docker logs --tail 80 "$task_container" >test/results/source-writer-mongo-last.log 2>&1 || true
    docker rm --force --volumes "$task_container" >/dev/null
  fi
  exit "$task_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cmake -S search-service -B test/build/search-foundation \
  -DAINVR_SEARCH_WITH_TOKENIZER=ON -DAINVR_SEARCH_WITH_BPU_TEXT=OFF \
  -DAINVR_SEARCH_BUILD_HARDWARE_PROBES=OFF
cmake --build test/build/search-foundation --target ainvr_search_history ainvr_search_mongo_ping -j2
"${CXX:-c++}" -std=c++17 -O1 -Wall -Wextra -Werror -pthread -Isearch-service/src \
  "$task_source" \
  test/build/search-foundation/libainvr_search_history.a \
  test/build/search-foundation/libainvr_search_sample_contract.a \
  test/build/search-foundation/libainvr_search_model_package.a \
  $(pkg-config --cflags --libs libmongoc-1.0) -lcrypto -o "$task_binary"
"${CXX:-c++}" -std=c++17 -O1 -Wall -Wextra -Werror -pthread -Isearch-service/src \
  test/search/source_writer_epoch_test.cpp -o test/build/search-writer-policy/epoch
# PID1 is an owned supervisor so an actual mongod restart retains the same
# bounded tmpfs data; no host/production Mongo/service is stopped or restarted.
docker run --detach --name "$task_container" --label "ainvr.test.run=$task_run" \
  --network host --memory 768m --cpus 0.75 --log-driver json-file \
  --log-opt max-size=1m --log-opt max-file=1 \
  --tmpfs /data/db:rw,size=384m --tmpfs /data/configdb:rw,size=8m \
  --entrypoint /bin/bash "$task_image" -c '
    trap "exit 0" TERM INT
    while true; do
      mongod --bind_ip 127.0.0.1 --port 25440 --wiredTigerCacheSizeGB 0.25 \
        --setParameter enableTestCommands=1 --quiet
      sleep 0.1
    done' >/dev/null
task_ready=0
task_deadline=$((SECONDS+20))
while ((SECONDS < task_deadline)); do
  if timeout 1 test/build/search-foundation/ainvr_search_mongo_ping >/dev/null 2>&1; then task_ready=1; break; fi
  sleep 0.2
done
test "$task_ready" -eq 1 || { echo 'Owned test Mongo did not become ready.' >&2; exit 1; }
timeout 10 test/build/search-writer-policy/epoch
timeout 70 env AINVR_SEARCH_TEST_MONGO=1 AINVR_SEARCH_TEST_WRITER_RESTART=1 "$task_binary"
