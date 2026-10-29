#!/usr/bin/env bash
set -euo pipefail
task_benchmark=0
task_capacity=0
if (( $# )); then
  [[ $# -eq 1 ]] || { echo 'Unknown software test mode.' >&2; exit 1; }
  case $1 in
    --migration-throughput) task_benchmark=1 ;;
    --capacity-50k) task_capacity=1 ;;
    *) echo 'Unknown software test mode.' >&2; exit 1 ;;
  esac
fi
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
task_capacity_deadline=$((SECONDS + 300))
task_ssd_prepared=0
task_watch_pid=''
task_dir=''
task_ssd=''
sunrise() { setpriv --reuid=sunrise --regid=sunrise --init-groups env HOME=/home/sunrise USER=sunrise LOGNAME=sunrise "$@"; }
mkdir -p test/results/search-history
cleanup() {
  task_status=$?
  trap - EXIT INT TERM
  if [[ -n $task_watch_pid ]]; then
    touch "$task_dir/watch-done"
    wait "$task_watch_pid" || task_status=1
  fi
  if [[ "$(docker inspect --format '{{index .Config.Labels "ainvr.test.run"}}' "$task_container" 2>/dev/null || true)" == "$task_run" ]]; then
    if ((task_capacity)); then
      docker inspect --format '{{json .State}}' "$task_container" >"$task_dir/mongo-final-state.json" || task_status=1
      task_mongo_pid=$(docker inspect --format '{{.State.Pid}}' "$task_container")
      python3 - "$task_mongo_pid" "$task_dir/mongo-resources.json" <<'PY' || task_status=1
import json,sys
from pathlib import Path
pid=int(sys.argv[1]);result={'memory_limit_bytes':768*1024*1024,'cpu_limit':0.5,'memory_peak_bytes':None}
if pid>0:
    lines=(Path('/proc')/str(pid)/'cgroup').read_text().splitlines()
    unified=[line.split(':',2)[2]for line in lines if line.startswith('0::')]
    if len(unified)==1:
        root=Path('/sys/fs/cgroup')/unified[0].lstrip('/')
        peak=root/'memory.peak'
        if peak.is_file():result['memory_peak_bytes']=int(peak.read_text())
    if result['memory_peak_bytes']is None:
        memory=[line.split(':',2)[2]for line in lines if 'memory'in line.split(':',2)[1].split(',')]
        if len(memory)==1:
            peak=Path('/sys/fs/cgroup/memory')/memory[0].lstrip('/')/'memory.max_usage_in_bytes'
            if peak.is_file():result['memory_peak_bytes']=int(peak.read_text())
Path(sys.argv[2]).write_text(json.dumps(result))
PY
    fi
    docker logs --tail 80 "$task_container" >test/results/search-history/mongo-last.log 2>&1 || true
    # This container and its anonymous data volumes were created only here.
    docker rm --force --volumes "$task_container" >/dev/null
  fi
  if ((task_ssd_prepared)); then
    sunrise python3 test/search/managed_fixture_storage.py check "$task_dir" >"$task_dir/ssd-final.json" 2>"$task_dir/ssd-final.log" || task_status=1
    sunrise python3 test/search/managed_fixture_storage.py remove "$task_dir" >"$task_dir/ssd-cleanup.json" 2>"$task_dir/ssd-cleanup.log" || task_status=1
    python3 - "$task_dir" "$task_status" <<'PY'
import json,sys
from pathlib import Path
d=Path(sys.argv[1]);result={'schema_version':'search-migration-capacity-run-status-v1','exit_code':int(sys.argv[2]),'outcome':'INCOMPLETE','hardware':False,'actual_pg':False}
for key,name in [('measurement','capacity-run.json'),('ssd_sampled_peak','ssd-peak.json'),('ssd_final','ssd-final.json'),('ssd_cleanup','ssd-cleanup.json'),('mongo_resources','mongo-resources.json'),('native_resources','native-resources.json')]:
    try:result[key]=json.loads((d/name).read_text())
    except(FileNotFoundError,json.JSONDecodeError):result[key]=None
if result['exit_code']==0 and result['measurement']and all(c['completed_full_pass']for c in result['measurement']['cases'])and result['ssd_cleanup']and result['ssd_cleanup']['removed']:result['outcome']='COMPLETED_SOFTWARE_MEASUREMENT'
(d/'run-status.json').write_text(json.dumps(result,indent=2)+'\n')
PY
    printf 'Capacity software exit=%s; results=%s\n' "$task_status" "$task_dir"
  fi
  exit "$task_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if ((task_capacity)); then
  # Read existing software libraries; never reconfigure the shared Native build
  # while the production source manifest is frozen for another task.
  task_dir="$task_root/test/results/search-managed-parameter/capacity50k-$task_run"
  mkdir -p test/results/search-managed-parameter
  mkdir -m 0700 "$task_dir"
  chown sunrise:sunrise "$task_dir"
  sunrise python3 - "$task_dir" "$task_run" <<'PY'
import json,sys
from pathlib import Path
path=Path(sys.argv[1])/'managed-options.json'
with path.open('x')as f:json.dump({'schema':1,'mode':'capacity-software','test_profile':'capacity-50k','volume_id':'64a5b078-4c84-4766-9bc6-68c247294079','relative_path':'ainvr-tests/search-managed-capacity50k-'+sys.argv[2]},f)
path.chmod(0o600)
PY
  sunrise python3 test/search/managed_fixture_storage.py prepare "$task_dir" >"$task_dir/ssd-prepare.json"
  task_ssd_prepared=1
  task_ssd=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["path"])' "$task_dir/ssd-guard.json")
  sunrise mkdir -m 0700 "$task_ssd/mongo" "$task_ssd/index"
  timeout 60 nice -n 10 c++ -O3 -DNDEBUG -std=gnu++17 -Wall -Wextra -Werror \
    -DAINVR_INDEX_BUILDER_TESTING=1 -DAINVR_SHARD_FILES_TESTING=1 -DJSON_DIAGNOSTICS=0 -DJSON_USE_IMPLICIT_CONVERSIONS=1 \
    -Isearch-service/src -Ithird_party/cpp-httplib -I/usr/include/libmongoc-1.0 -I/usr/include/libbson-1.0 \
    test/search/migration_capacity_test.cpp -o "$task_dir/capacity-fixture" \
    -Ltest/build/search-foundation -lainvr_search_index_runtime_test_impl -lainvr_search_index_builder_test_impl \
    -lainvr_search_index_jobs -lainvr_search_index_shard_files_test_impl -lainvr_search_http -lainvr_search_history \
    -lainvr_search_sample_contract -lmongoc-1.0 -lbson-1.0 -lainvr_search_model_package -lcrypto
else
  cmake -S search-service -B test/build/search-foundation \
  -DAINVR_SEARCH_WITH_TOKENIZER=ON -DAINVR_SEARCH_WITH_BPU_TEXT=OFF \
  -DAINVR_SEARCH_BUILD_HARDWARE_PROBES=OFF
  if ((task_benchmark)); then
    cmake --build test/build/search-foundation --target ainvr_search_migration_throughput ainvr_search_mongo_ping -j2
  else
    cmake --build test/build/search-foundation -j2
  fi
fi
if ((task_capacity)); then
  docker run --detach --name "$task_container" --label "ainvr.test.run=$task_run" \
    --network host --memory 768m --cpus 0.5 --user "$(id -u sunrise):$(id -g sunrise)" \
    --log-driver local --log-opt max-size=1m --log-opt max-file=1 --log-opt compress=false \
    --mount "type=bind,source=$task_ssd/mongo,target=/data/db" --tmpfs /data/configdb:rw,size=8m "$task_image" \
    mongod --bind_ip 127.0.0.1 --port 25440 --wiredTigerCacheSizeGB 0.25 --quiet >/dev/null
  # This is an explicit watchdog quota, not a filesystem hard quota. A breach
  # records INCOMPLETE and stops only the exact run-labelled test container.
  (
    while [[ ! -e $task_dir/watch-done ]]; do
      if ! timeout 5 setpriv --reuid=sunrise --regid=sunrise --init-groups env HOME=/home/sunrise USER=sunrise LOGNAME=sunrise python3 test/search/managed_fixture_storage.py check "$task_dir" >"$task_dir/ssd-current.tmp" 2>"$task_dir/ssd-watch.log"; then
        printf '%s\n' INCOMPLETE_STORAGE_QUOTA_OR_IDENTITY >"$task_dir/storage-incomplete"
        if [[ $(docker inspect --format '{{index .Config.Labels "ainvr.test.run"}}' "$task_container" 2>/dev/null || true) == "$task_run" ]]; then docker stop --time 3 "$task_container" >/dev/null; fi
        exit 1
      fi
      python3 - "$task_dir" <<'PY'
import json,sys
from pathlib import Path
d=Path(sys.argv[1]);current=json.loads((d/'ssd-current.tmp').read_text());path=d/'ssd-peak.json'
peak=json.loads(path.read_text())if path.exists()else {'bytes':0,'physical_bytes':0,'samples':0}
peak['samples']+=1
for k in('bytes','physical_bytes'):peak[k]=max(peak[k],current[k])
parts=peak.setdefault('profile_usage',{})
for name,usage in current['profile_usage'].items():
    old=parts.setdefault(name,{'logical_bytes':0,'physical_bytes':0})
    for k in('logical_bytes','physical_bytes'):old[k]=max(old[k],usage[k])
path.write_text(json.dumps(peak))
PY
      sleep .5
    done
  ) &
  task_watch_pid=$!
else
docker run --detach --name "$task_container" --label "ainvr.test.run=$task_run" \
  --network host --memory 768m --cpus 0.5 \
  --tmpfs /data/db:rw,size=384m --tmpfs /data/configdb:rw,size=8m "$task_image" \
  mongod --bind_ip 127.0.0.1 --port 25440 --wiredTigerCacheSizeGB 0.25 --quiet >/dev/null
fi
task_ready=0
task_deadline=$((SECONDS + 20))
while (( SECONDS < task_deadline )); do
  if timeout 1 test/build/search-foundation/ainvr_search_mongo_ping >/dev/null 2>&1; then task_ready=1; break; fi
  sleep 0.2
done
test "$task_ready" -eq 1 || { printf '%s\n' 'Isolated test Mongo did not become ready.' >&2; exit 1; }
if ((task_capacity)); then
  task_remaining=$((task_capacity_deadline - SECONDS))
  [[ $task_remaining -gt 0 ]] || { printf '%s\n' INCOMPLETE_TOTAL_DEADLINE >"$task_dir/deadline-incomplete"; exit 1; }
  timeout "$task_remaining" python3 - "$task_dir" "$task_ssd/index" <<'PY'
import json,resource,subprocess,sys,time
from pathlib import Path
d=Path(sys.argv[1]);start=time.monotonic()
command=['setpriv','--reuid=sunrise','--regid=sunrise','--init-groups','env','HOME=/home/sunrise','USER=sunrise','LOGNAME=sunrise',
 'AINVR_SEARCH_TEST_MONGO=1','AINVR_SEARCH_CAPACITY_SSD_ROOT='+sys.argv[2],'AINVR_SEARCH_CAPACITY_REPORT='+str(d/'capacity-run.json'),str(d/'capacity-fixture')]
with(d/'native.log').open('w')as log:result=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,check=False)
usage=resource.getrusage(resource.RUSAGE_CHILDREN)
(d/'native-resources.json').write_text(json.dumps({'elapsed_ms':(time.monotonic()-start)*1000,'maxrss_kib':usage.ru_maxrss,'user_seconds':usage.ru_utime,'system_seconds':usage.ru_stime,'exit_code':result.returncode}))
raise SystemExit(result.returncode)
PY
  python3 - "$task_dir/capacity-run.json" <<'PY'
import json,sys
report=json.load(open(sys.argv[1]));print(json.dumps(report))
if not all(case['completed_full_pass']for case in report['cases']):raise SystemExit('INCOMPLETE_FINAL_PHASE_DEADLINE')
PY
elif ((task_benchmark)); then
  timeout 180 env AINVR_SEARCH_TEST_MONGO=1 test/build/search-foundation/ainvr_search_migration_throughput
else
  timeout 60 env AINVR_SEARCH_TEST_MONGO=1 ctest --test-dir test/build/search-foundation \
    --output-on-failure | tee test/results/search-history/native-last.log
fi
