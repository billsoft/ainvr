#!/usr/bin/env bash
# Explicit, bounded hardware integration. Never part of ordinary software CTest.
set -euo pipefail
[[ ${1:-} == --run-hardware && $# == 1 ]] || {
  printf '%s\n' 'Usage: run-bpu-search-integration.sh --run-hardware' >&2; exit 64;
}
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$task_root"
umask 077
mkdir -p test/results/search-bpu-e2e
exec 9>test/results/search-hardware-integration.lock
flock -n 9 || { printf '%s\n' 'Another owned hardware test is active.' >&2; exit 1; }
exec 8>test/results/search-native.lock
flock -n 8 || { printf '%s\n' 'Another isolated search Mongo test is active.' >&2; exit 1; }
for task_port in 8400 25440; do
  [[ -z $(ss -H -ltn "( sport = :$task_port )") ]] || {
    printf 'Test port %s is occupied; no existing process was changed.\n' "$task_port" >&2; exit 1;
  }
done
task_server="$task_root/out/search-text-integration/ainvr_search_bpu_integration_server"
task_client="$task_root/test/build/search-hardware-ai/build/ai/ainvr_search_bpu_integration_client"
task_input="$task_root/test/runtime/official-multimedia-samples-4.0.5-20260211104018/sample_codec/1920x1080_NV12.yuv"
[[ -x $task_server && -x $task_client && -r $task_input && -x test/build/search-foundation/ainvr_search_mongo_ping ]] || {
  printf '%s\n' 'Build both explicit probe targets and install the official NV12 test asset first.' >&2; exit 1;
}
task_run="$(date -u +%Y%m%dT%H%M%SZ)_$$"
task_container="ainvr-search-bpu-e2e-${task_run//_/-}"
task_database="ainvr_search_bpu_e2e_$task_run"
task_dir="$task_root/test/results/search-bpu-e2e/$task_run"
mkdir -m 0700 "$task_dir"
task_server_pid=''
task_image=$(docker image inspect --format '{{.Id}}' mongo:7.0)
cleanup() {
  task_status=$?
  trap - EXIT INT TERM
  if [[ -n $task_server_pid && -r /proc/$task_server_pid/cmdline ]]; then
    task_cmd=$(tr '\0' ' ' </proc/"$task_server_pid"/cmdline)
    if [[ $task_cmd == *"$task_server --run-hardware --database $task_database"* ]]; then
      kill -TERM "$task_server_pid" 2>/dev/null || true
      wait "$task_server_pid" 2>/dev/null || true
    fi
  fi
  if [[ $(docker inspect --format '{{index .Config.Labels "ainvr.test.run"}}' "$task_container" 2>/dev/null || true) == "$task_run" ]]; then
    docker logs --tail 50 "$task_container" >"$task_dir/mongo.log" 2>&1 || true
    docker rm --force --volumes "$task_container" >/dev/null
  fi
  rm -f -- "$task_dir/server.pid"
  exit "$task_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker run --detach --name "$task_container" --label "ainvr.test.run=$task_run" \
  --network host --memory 768m --cpus 0.5 \
  --tmpfs /data/db:rw,size=384m --tmpfs /data/configdb:rw,size=8m \
  "$task_image" mongod --bind_ip 127.0.0.1 --port 25440 --wiredTigerCacheSizeGB 0.25 --quiet >/dev/null
task_ready=0
task_deadline=$((SECONDS + 25))
while (( SECONDS < task_deadline )); do
  if timeout 1 test/build/search-foundation/ainvr_search_mongo_ping >/dev/null 2>&1; then task_ready=1; break; fi
  sleep 0.2
done
[[ $task_ready == 1 ]] || { printf '%s\n' 'Isolated tmpfs Mongo did not become ready.' >&2; exit 1; }
env AINVR_SEARCH_TEST_MONGO=1 timeout 150 "$task_server" --run-hardware --database "$task_database" \
  >"$task_dir/server.log" 2>&1 &
task_server_pid=$!
printf '%s\n' "$task_server_pid" >"$task_dir/server.pid"
task_ready=0
task_deadline=$((SECONDS + 40))
while (( SECONDS < task_deadline )); do
  if curl -fsS --max-time 1 http://127.0.0.1:8400/health >"$task_dir/health.json" 2>/dev/null; then task_ready=1; break; fi
  kill -0 "$task_server_pid" 2>/dev/null || break
  sleep 0.2
done
[[ $task_ready == 1 ]] || { printf '%s\n' 'Real text-model integration server did not become ready.' >&2; exit 1; }
env AINVR_SEARCH_TEST_MONGO=1 timeout 150 "$task_client" --run-hardware --input-nv12 "$task_input" \
  --matrix bt601 --range limited --report "$task_dir/result.json" >"$task_dir/client.log" 2>&1
printf 'Bounded real-model interface report: %s/result.json\n' "$task_dir"
printf '%s\n' 'This is a forced-ROI integration fixture, not a detector or semantic-accuracy evaluation.'
