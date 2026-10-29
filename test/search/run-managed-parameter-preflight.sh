#!/usr/bin/env bash
# Shared isolated harness. Hardware requires its separate explicit option.
set -euo pipefail
[[ $# == 1 && ( ${1:-} == --run-isolated || ${1:-} == --run-hardware ) ]] || { printf '%s\n' 'Usage: run-managed-parameter-preflight.sh --run-isolated | --run-hardware'; exit 64; }
task_mode=software-preflight
[[ $1 != --run-hardware ]] || task_mode=managed-hardware
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$task_root"
umask 077
[[ ! -L test/results/search-managed-parameter ]] || { printf '%s\n' 'Fixture parent must not be a symlink.' >&2; exit 1; }
mkdir -p test/results/search-managed-parameter
chmod 0711 test/results/search-managed-parameter
exec 9>test/results/search-config-pg.lock
flock -n 9 || { printf '%s\n' 'Another isolated PG test is active.' >&2; exit 1; }
exec 8>test/results/search-native.lock
flock -n 8 || { printf '%s\n' 'Another isolated Native/Mongo test is active.' >&2; exit 1; }
task_ports=(25439 25440 25441)
if [[ $task_mode == managed-hardware ]]; then
  exec 7>test/results/search-hardware-integration.lock
  flock -n 7 || { printf '%s\n' 'Another owned hardware test is active.' >&2; exit 1; }
  task_ports+=(8400)
  python3 - <<'PY'
import os,fcntl
p='/run/ainvr/search-service.lock'
if os.path.lexists(p):
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
 try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 finally:os.close(fd)
PY
fi
for task_port in "${task_ports[@]}"; do
  [[ -z $(ss -H -ltn "( sport = :$task_port )") ]] || { printf 'Test port %s occupied; no process changed.\n' "$task_port" >&2; exit 1; }
done
task_run="$(date -u +%Y%m%dT%H%M%SZ)_$$"
task_dir="$task_root/test/results/search-managed-parameter/$task_run"
mkdir -m 0700 "$task_dir"
chown sunrise:sunrise "$task_dir"
task_pg="ainvr-managed-pg-${task_run//_/-}"
task_mongo="ainvr-managed-mongo-${task_run//_/-}"
task_fixture_pid=''
task_native_pid=''
task_ssd_prepared=0
task_node=/opt/ainvr/node-v24.20.0-linux-arm64/bin/node
task_native="$task_root/out/search-text-integration/ainvr_search_service"
task_client="$task_root/test/build/search-hardware-ai/build/ai/ainvr_search_bpu_integration_client"
sunrise() { setpriv --reuid=sunrise --regid=sunrise --init-groups env HOME=/home/sunrise USER=sunrise LOGNAME=sunrise "$@"; }
identities() {
  systemctl show ainvr-ai ainvr-llm ainvr-backend ainvr-recorder ainvr-ingest ainvr-alarm ainvr-web ainvr-onvif ainvr-gb28181 ainvr-gb-media \
    ainvr-license ainvr-os-helper ainvr-restart-helper ainvr-review-reference \
    --property=Id,MainPID,ActiveState,ExecMainStartTimestampMonotonic
  docker inspect --format '{{.State.Pid}} {{.State.StartedAt}}' ainvr-srs
}
stop_owned() {
  local task_pid=$1 task_pattern=$2 task_max=$3
  [[ $task_pid =~ ^[1-9][0-9]{0,9}$ && -r /proc/$task_pid/cmdline ]] || return 0
  local task_command
  task_command=$(tr '\0' ' ' </proc/"$task_pid"/cmdline)
  [[ $task_command == *"$task_pattern"* ]] || { printf '%s\n' 'Owned process identity changed; refusing a signal.' >&2; return 1; }
  kill -TERM "$task_pid" 2>/dev/null || true
  for ((task_wait=0; task_wait<task_max*10; ++task_wait)); do
    kill -0 "$task_pid" 2>/dev/null || { wait "$task_pid" 2>/dev/null || true; return 0; }
    sleep .1
  done
  printf 'Owned process %s did not stop; no force-kill or automatic reload was performed.\n' "$task_pid" >&2
  return 1
}
cleanup() {
  task_status=$?
  trap - EXIT INT TERM
  if [[ $task_mode == managed-hardware ]]; then
    task_custody=0
    if [[ -f $task_dir/client.pid ]]; then
      task_client_pid=$(cat "$task_dir/client.pid")
      stop_owned "$task_client_pid" "$task_client --run-hardware" 45 || task_custody=1
    fi
    [[ -z $task_native_pid ]] || stop_owned "$task_native_pid" "$task_native --managed-config $task_dir/search-service-bootstrap.json" 45 || task_custody=1
    if [[ $task_custody != 0 ]]; then
      printf '%s\n' 'Manual attention required: model process ownership is unresolved; owned databases/SSD evidence were retained.' >&2
      exit 98
    fi
    [[ -z $task_fixture_pid ]] || stop_owned "$task_fixture_pid" "$task_root/test/search/index_parameter_fixture.mts --run-managed-fixture $task_dir" 12 || task_status=98
    if [[ $task_ssd_prepared == 1 ]]; then
      sunrise python3 "$task_root/test/search/managed_fixture_storage.py" remove "$task_dir" >"$task_dir/ssd-cleanup.json" 2>"$task_dir/ssd-cleanup.log" || task_status=98
    fi
    if [[ -f $task_dir/services-before.txt ]]; then
      identities >"$task_dir/services-after.txt" || task_status=98
      cmp -s "$task_dir/services-before.txt" "$task_dir/services-after.txt" || task_status=98
    fi
  fi
  for task_container in "$task_pg" "$task_mongo"; do
    if [[ $(docker inspect --format '{{index .Config.Labels "ainvr.test.run"}}' "$task_container" 2>/dev/null || true) == "$task_run" ]]; then
      docker logs --tail 30 "$task_container" >"$task_dir/$task_container.log" 2>&1 || true
      docker rm --force --volumes "$task_container" >/dev/null
    fi
  done
  if [[ $task_mode == managed-hardware && $task_status == 0 ]]; then
    printf '%s\n' '{"passed":true,"managed_hardware_phase":true,"owned_ssd_removed":true,"original_service_identities_unchanged":true,"semantic_accuracy_verified":false}' >"$task_dir/run-complete.json"
  fi
  printf 'Managed parameter preflight exit=%s; results=%s\n' "$task_status" "$task_dir"
  exit "$task_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
task_pg_image=$(docker image inspect --format '{{.Id}}' postgres:16-alpine)
task_mongo_image=$(docker image inspect --format '{{.Id}}' mongo:7.0)
if [[ $task_mode == managed-hardware ]]; then
  [[ -x $task_native && -x $task_client ]] || { printf '%s\n' 'Compile the current managed server and client first.' >&2; exit 1; }
  "$task_client" --help | grep -q -- '--validate-managed-access' || { printf '%s\n' 'The linked client predates managed-access validation.' >&2; exit 1; }
  identities >"$task_dir/services-before.txt"
fi
docker run --detach --name "$task_pg" --label "ainvr.test.run=$task_run" --network host --memory 384m --cpus 0.5 \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,size=256m -e POSTGRES_USER=alarm_test -e POSTGRES_DB=alarm_test \
  -e POSTGRES_HOST_AUTH_METHOD=trust "$task_pg_image" postgres -p 25439 -c listen_addresses=127.0.0.1 >/dev/null
docker run --detach --name "$task_mongo" --label "ainvr.test.run=$task_run" --network host --memory 768m --cpus 0.5 \
  --tmpfs /data/db:rw,size=384m --tmpfs /data/configdb:rw,size=8m "$task_mongo_image" \
  mongod --bind_ip 127.0.0.1 --port 25440 --wiredTigerCacheSizeGB 0.25 --quiet >/dev/null
task_ready=0
for ((task_n=0; task_n<40; ++task_n)); do
  if docker exec "$task_pg" pg_isready -p 25439 -U alarm_test -d alarm_test >/dev/null 2>&1 && \
      docker exec "$task_mongo" mongosh --quiet --host 127.0.0.1 --port 25440 --eval 'quit(db.runCommand({ping:1}).ok ? 0 : 1)' >/dev/null 2>&1; then task_ready=1; break; fi
  sleep .25
done
[[ $task_ready == 1 ]] || { printf '%s\n' 'Isolated databases did not become ready.' >&2; exit 1; }
sunrise python3 - "$task_dir" "$task_run" "$task_mode" <<'PY'
import json,sys
from pathlib import Path
path=Path(sys.argv[1])/'managed-options.json'
with path.open('x') as f:json.dump({'schema':1,'mode':sys.argv[3],'volume_id':'64a5b078-4c84-4766-9bc6-68c247294079','relative_path':'ainvr-tests/search-managed-'+sys.argv[2]},f)
path.chmod(0o600)
PY
if [[ $task_mode == software-preflight ]]; then
  timeout 50 setpriv --reuid=sunrise --regid=sunrise --init-groups env HOME=/home/sunrise USER=sunrise LOGNAME=sunrise AINVR_SEARCH_TEST_PG=1 \
    "$task_node" --import "$task_root/srs-web-console/backend/node_modules/tsx/dist/loader.mjs" \
    "$task_root/test/search/managed_parameter_preflight.mts" --run-software-preflight "$task_dir"
else
  sunrise python3 "$task_root/test/search/managed_fixture_storage.py" prepare "$task_dir" >"$task_dir/ssd-prepare.json"
  task_ssd_prepared=1
  setpriv --reuid=sunrise --regid=sunrise --init-groups env HOME=/home/sunrise USER=sunrise LOGNAME=sunrise AINVR_SEARCH_TEST_PG=1 "$task_node" --import "$task_root/srs-web-console/backend/node_modules/tsx/dist/loader.mjs" \
    "$task_root/test/search/index_parameter_fixture.mts" --run-managed-fixture "$task_dir" >"$task_dir/parameter.log" 2>&1 &
  task_fixture_pid=$!
  printf '%s\n' "$task_fixture_pid" >"$task_dir/parameter.pid"
  task_ready=0
  for ((task_n=0; task_n<150; ++task_n)); do
    [[ ! -f $task_dir/parameter-ready.json ]] || { task_ready=1; break; }
    kill -0 "$task_fixture_pid" 2>/dev/null || break
    sleep .1
  done
  [[ $task_ready == 1 ]] || { printf '%s\n' 'Managed parameter fixture did not become ready.' >&2; exit 1; }
  setpriv --reuid=sunrise --regid=sunrise --init-groups env HOME=/home/sunrise USER=sunrise LOGNAME=sunrise "$task_native" --managed-config "$task_dir/search-service-bootstrap.json" >"$task_dir/native.log" 2>&1 &
  task_native_pid=$!
  printf '%s\n' "$task_native_pid" >"$task_dir/native.pid"
  timeout 200 setpriv --reuid=sunrise --regid=sunrise --init-groups env HOME=/home/sunrise USER=sunrise LOGNAME=sunrise AINVR_SEARCH_TEST_MONGO=1 \
    "$task_node" --import "$task_root/srs-web-console/backend/node_modules/tsx/dist/loader.mjs" \
    "$task_root/test/search/managed_parameter_hardware_steps.mts" --run-hardware "$task_dir"
fi
