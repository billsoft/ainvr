#!/usr/bin/env bash
set -euo pipefail
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$task_root"
mkdir -p /mnt/ainvr-ssd/ainvr-tests
task_case=$(mktemp -d /mnt/ainvr-ssd/ainvr-tests/review-cache-XXXXXXXX)
small_raw="$task_case/small_spool/raw"
cleanup(){
 if mountpoint -q "$small_raw"; then umount "$small_raw"; fi
 python3 - "$task_case" <<'PY'
import pathlib,shutil,sys
p=pathlib.Path(sys.argv[1]);assert p.parent==pathlib.Path('/mnt/ainvr-ssd/ainvr-tests') and p.name.startswith('review-cache-') and p.resolve()==p
shutil.rmtree(p)
PY
}
trap cleanup EXIT
g++ -std=c++17 -O1 -Wall -Wextra -Werror -Wno-misleading-indentation -pthread -I/usr/include/opencv4 \
 test/ai_port/review_frame_cache_test.cpp -lopencv_core -lcrypto -o "$task_case/review_frame_cache_test"
task_modes=(queue pixels ttl targets receipts shutdown backpressure encoded persist_failure region full_spool abandon batch stall spool_space small_spool orphans)
if [[ ${1:-all} != all ]]; then task_modes=("$1"); fi
for task_mode in "${task_modes[@]}"; do
 if [[ $task_mode == small_spool ]]; then
  # A real memory filesystem; the budget must come from its size.
  if [[ $(id -u) != 0 ]]; then echo "small_spool requires root to mount a 4 MiB tmpfs" >&2; exit 1; fi
  mkdir -p "$small_raw"; mount -t tmpfs -o size=4m,mode=0700 tmpfs "$small_raw"
 fi
 timeout 15 "$task_case/review_frame_cache_test" "$task_case/$task_mode" "$task_mode"
done
