#!/usr/bin/env bash
# Real isolated PG + Mongo + production route/Native runtime. No BPU or service changes.
set -euo pipefail
[[ ${1:-} == --run-isolated && $# == 1 ]] || { printf '%s\n' 'Usage: run-index-wire.sh --run-isolated'; exit 64; }
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$task_root"
umask 077
mkdir -p test/results/search-index-wire
exec 9>test/results/search-config-pg.lock
flock -n 9 || { printf '%s\n' 'Another isolated PG test is active.' >&2; exit 1; }
exec 8>test/results/search-native.lock
flock -n 8 || { printf '%s\n' 'Another isolated Native/Mongo test is active.' >&2; exit 1; }
for task_port in 25439 25440 25441; do
  [[ -z $(ss -H -ltn "( sport = :$task_port )") ]] || { printf 'Test port %s is occupied; no process was changed.\n' "$task_port" >&2; exit 1; }
done
task_run="$(date -u +%Y%m%dT%H%M%SZ)_$$"
task_dir="$task_root/test/results/search-index-wire/$task_run"
mkdir -m 0700 "$task_dir"
task_pg="ainvr-search-index-pg-${task_run//_/-}"
task_mongo="ainvr-search-index-mongo-${task_run//_/-}"
task_fixture_pid=''
cleanup() {
  task_status=$?
  trap - EXIT INT TERM
  if [[ -n $task_fixture_pid && -r /proc/$task_fixture_pid/cmdline ]]; then
    task_command=$(tr '\0' ' ' </proc/"$task_fixture_pid"/cmdline)
    if [[ $task_command == *"$task_root/test/search/index_parameter_fixture.mts --run-isolated-fixture $task_dir"* ]]; then
      kill -TERM "$task_fixture_pid" 2>/dev/null || true
      for ((task_n=0; task_n<40; ++task_n)); do kill -0 "$task_fixture_pid" 2>/dev/null || break; sleep .1; done
      if kill -0 "$task_fixture_pid" 2>/dev/null; then kill -KILL "$task_fixture_pid" 2>/dev/null || true; fi
      wait "$task_fixture_pid" 2>/dev/null || true
    else
      printf '%s\n' 'Fixture identity changed; no unrelated process was killed.' >&2
      task_status=98
    fi
  fi
  for task_container in "$task_pg" "$task_mongo"; do
    if [[ $(docker inspect --format '{{index .Config.Labels "ainvr.test.run"}}' "$task_container" 2>/dev/null || true) == "$task_run" ]]; then
      docker logs --tail 40 "$task_container" >"$task_dir/$task_container.log" 2>&1 || true
      docker rm --force --volumes "$task_container" >/dev/null
    fi
  done
  printf 'Index wire test exit=%s; results=%s\n' "$task_status" "$task_dir"
  exit "$task_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cmake -S search-service -B out/search-index-wire-software -DAINVR_SEARCH_WITH_TOKENIZER=OFF -DAINVR_SEARCH_WITH_BPU_TEXT=OFF -DAINVR_SEARCH_BUILD_HARDWARE_PROBES=OFF >"$task_dir/build.log" 2>&1
cmake --build out/search-index-wire-software --target ainvr_search_index_runtime_test ainvr_search_mongo_ping -j2 >>"$task_dir/build.log" 2>&1
task_pg_image=$(docker image inspect --format '{{.Id}}' postgres:16-alpine)
task_mongo_image=$(docker image inspect --format '{{.Id}}' mongo:7.0)
docker run --detach --name "$task_pg" --label "ainvr.test.run=$task_run" --network host --memory 384m --cpus 0.5 \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,size=256m -e POSTGRES_USER=alarm_test -e POSTGRES_DB=alarm_test \
  -e POSTGRES_HOST_AUTH_METHOD=trust "$task_pg_image" postgres -p 25439 -c listen_addresses=127.0.0.1 >/dev/null
docker run --detach --name "$task_mongo" --label "ainvr.test.run=$task_run" --network host --memory 768m --cpus 0.5 \
  --tmpfs /data/db:rw,size=384m --tmpfs /data/configdb:rw,size=8m "$task_mongo_image" \
  mongod --bind_ip 127.0.0.1 --port 25440 --wiredTigerCacheSizeGB 0.25 --quiet >/dev/null
task_ready=0
for ((task_n=0; task_n<30; ++task_n)); do
  if docker exec "$task_pg" pg_isready -p 25439 -U alarm_test -d alarm_test >/dev/null 2>&1 &&
      timeout 1 out/search-index-wire-software/ainvr_search_mongo_ping >/dev/null 2>&1; then task_ready=1; break; fi
  sleep .5
done
[[ $task_ready == 1 ]] || { printf '%s\n' 'Isolated databases did not become ready.' >&2; exit 1; }
env AINVR_SEARCH_TEST_PG=1 node --import "$task_root/srs-web-console/backend/node_modules/tsx/dist/loader.mjs" \
  "$task_root/test/search/index_parameter_fixture.mts" --run-isolated-fixture "$task_dir" >"$task_dir/parameter.log" 2>&1 &
task_fixture_pid=$!
task_ready=0
for ((task_n=0; task_n<100; ++task_n)); do
  if [[ -f $task_dir/parameter-ready.json ]]; then task_ready=1; break; fi
  kill -0 "$task_fixture_pid" 2>/dev/null || break
  sleep .1
done
[[ $task_ready == 1 ]] || { printf '%s\n' 'Isolated parameter fixture did not become ready.' >&2; exit 1; }
if timeout 65 env AINVR_SEARCH_TEST_MONGO=1 AINVR_SEARCH_TEST_CONTROL_URL=http://127.0.0.1:25441 \
    out/search-index-wire-software/ainvr_search_index_runtime_test >"$task_dir/native.log" 2>&1; then
  task_result=0
else
  task_result=$?
  curl -fsS --max-time 3 -H 'x-service-token: ssssssssssssssssssssssssssssssssssssssssssssssss' \
    http://127.0.0.1:25441/fixture/state >"$task_dir/failure-state.json" || true
  cat "$task_dir/native.log" "$task_dir/failure-state.json"
  exit "$task_result"
fi
printf '%s\n' '{"passed":true,"real_pg":true,"real_mongo":true,"real_http":true,"synthetic_vectors":true,"bpu_executed":false,"real_ssd":false,"lost_response_reconciled":true,"restart_restored":true,"retired_gc":true}' >"$task_dir/result.json"
cat "$task_dir/native.log"
