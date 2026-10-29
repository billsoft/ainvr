#!/usr/bin/env bash
set -euo pipefail
task_with_pg=0
if [[ $# -gt 0 ]]; then
  [[ $# -eq 1 && $1 == --with-pg ]] || { printf '%s\n' 'Usage: run-native-bff.sh [--with-pg]'; exit 64; }
  task_with_pg=1
fi
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$task_root"
test -f search-service/CMakeLists.txt
mkdir -p test/results/search-native-bff
exec 9>test/results/search-native.lock
flock -n 9 || { printf '%s\n' 'Another native BFF integration test owns this runner.' >&2; exit 1; }
test -z "$(ss -H -ltn '( sport = :25440 )')" || { printf '%s\n' 'Isolated Mongo port 25440 is already occupied; no process was changed.' >&2; exit 1; }
if [[ $task_with_pg == 1 ]]; then
  exec 8>test/results/search-config-pg.lock
  flock -n 8 || { printf '%s\n' 'Another isolated PG test owns port 25439.' >&2; exit 1; }
  test -z "$(ss -H -ltn '( sport = :25439 )')" || { printf '%s\n' 'Isolated PG port 25439 is already occupied; no process was changed.' >&2; exit 1; }
fi
task_run="search-native-bff-$(date -u +%Y%m%dT%H%M%SZ)-$$"
task_container="ainvr-$task_run"
task_pg_container="ainvr-pg-$task_run"
task_image=$(docker image inspect --format '{{.Id}}' mongo:7.0)
cleanup() {
  task_status=$?
  task_cleanup_failed=0
  trap - EXIT INT TERM
  # Compare run ID, executable and Linux start time before signaling, so a
  # reused PID or stale record cannot stop a different process.
  python3 - "$task_root" "$task_run" <<'PY' || task_cleanup_failed=1
import json, os, signal, sys, time
from pathlib import Path
root = Path(sys.argv[1]).resolve()
record_path = root / 'test/results/search-native-bff/fixture-pid.json'
if not record_path.is_file():
    raise SystemExit(0)
record = json.loads(record_path.read_text())
expected = (root / 'test/build/search-foundation/ainvr_search_fixture_server').resolve()
pid = record.get('pid')
if record.get('run_id') != sys.argv[2] or not isinstance(pid, int) or pid < 2 or Path(record.get('executable', '')).resolve() != expected:
    raise SystemExit('Refusing invalid or unowned fixture PID record')
proc = Path('/proc') / str(pid)
def owns():
    try:
        text = (proc / 'stat').read_text()
        start = text[text.rfind(')') + 2:].split()[19]
        return (proc / 'exe').resolve() == expected and start == record.get('start_time')
    except (FileNotFoundError, ProcessLookupError):
        return False
if owns():
    os.kill(pid, signal.SIGTERM)
    until = time.monotonic() + 3
    while owns() and time.monotonic() < until:
        time.sleep(.05)
    if owns():
        os.kill(pid, signal.SIGKILL)
record_path.unlink(missing_ok=True)
PY
  if [[ "$(docker inspect --format '{{index .Config.Labels "ainvr.test.run"}}' "$task_container" 2>/dev/null || true)" == "$task_run" ]]; then
    docker logs --tail 80 "$task_container" >"$task_root/test/results/search-native-bff/mongo-last.log" 2>&1 || true
    docker rm --force --volumes "$task_container" >/dev/null || task_cleanup_failed=1
  fi
  if [[ "$(docker inspect --format '{{index .Config.Labels "ainvr.test.run"}}' "$task_pg_container" 2>/dev/null || true)" == "$task_run" ]]; then
    docker rm --force --volumes "$task_pg_container" >/dev/null || task_cleanup_failed=1
  fi
  if [[ "$task_status" -eq 0 && "$task_cleanup_failed" -ne 0 ]]; then task_status=1; fi
  exit "$task_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cmake -S search-service -B test/build/search-foundation -DAINVR_SEARCH_WITH_TOKENIZER=OFF -DAINVR_SEARCH_WITH_BPU_TEXT=OFF -DAINVR_SEARCH_BUILD_HARDWARE_PROBES=OFF
cmake --build test/build/search-foundation --target ainvr_search_fixture_server ainvr_search_mongo_ping -j2
if [[ $task_with_pg == 1 ]]; then
  task_pg_image=$(docker image inspect --format '{{.Id}}' postgres:16-alpine)
  docker run --detach --name "$task_pg_container" --label "ainvr.test.run=$task_run" --network host --memory 384m --cpus 0.5 \
    --tmpfs /var/lib/postgresql/data:rw,nosuid,size=256m -e POSTGRES_USER=alarm_test -e POSTGRES_DB=alarm_test \
    -e POSTGRES_HOST_AUTH_METHOD=trust "$task_pg_image" postgres -p 25439 -c listen_addresses=127.0.0.1 >/dev/null
fi
docker run --detach --name "$task_container" --label "ainvr.test.run=$task_run" \
  --network host --memory 768m --cpus 0.5 \
  --tmpfs /data/db:rw,size=384m --tmpfs /data/configdb:rw,size=8m "$task_image" \
  mongod --bind_ip 127.0.0.1 --port 25440 --wiredTigerCacheSizeGB 0.25 --quiet >/dev/null
task_ready=0
task_deadline=$((SECONDS + 20))
while (( SECONDS < task_deadline )); do
  if timeout 1 test/build/search-foundation/ainvr_search_mongo_ping >/dev/null 2>&1 &&
    { [[ $task_with_pg == 0 ]] || docker exec "$task_pg_container" pg_isready -p 25439 -U alarm_test -d alarm_test >/dev/null 2>&1; }; then task_ready=1; break; fi
  sleep 0.2
done
test "$task_ready" -eq 1 || { printf '%s\n' 'Isolated test Mongo did not become ready.' >&2; exit 1; }
cd srs-web-console/backend
timeout --signal=TERM --kill-after=5 50 env AINVR_SEARCH_TEST_MONGO=1 AINVR_SEARCH_TEST_PG="$task_with_pg" AINVR_SEARCH_TEST_RUN_ID="$task_run" \
  npx vitest run src/test/searchNativeIntegration.test.ts 2>&1 | tee "$task_root/test/results/search-native-bff/last.log"
