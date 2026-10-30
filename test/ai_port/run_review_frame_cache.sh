#!/usr/bin/env bash
set -euo pipefail
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$task_root"
mkdir -p test/build/review-frame-cache /mnt/ainvr-ssd/ainvr-tests
g++ -std=c++17 -O1 -Wall -Wextra -Werror -Wno-misleading-indentation -pthread -I/usr/include/opencv4 \
 test/ai_port/review_frame_cache_test.cpp -lopencv_core -lcrypto -o test/build/review-frame-cache/review_frame_cache_test
task_case=$(mktemp -d /mnt/ainvr-ssd/ainvr-tests/review-cache-XXXXXXXX)
cleanup(){
 python3 - "$task_case" <<'PY'
import pathlib,shutil,sys
p=pathlib.Path(sys.argv[1]);assert p.parent==pathlib.Path('/mnt/ainvr-ssd/ainvr-tests') and p.name.startswith('review-cache-') and p.resolve()==p
shutil.rmtree(p)
PY
}
trap cleanup EXIT
task_modes=(queue pixels ttl targets)
if [[ ${1:-all} != all ]]; then task_modes=("$1"); fi
for task_mode in "${task_modes[@]}"; do
 # Only this child mount namespace sees a fresh tmpfs at the live cache path.
 # The production namespace and files are never mounted over or removed.
 unshare --mount bash -eu -c '
  mount --make-rprivate /
  mount -t tmpfs -o size=16m tmpfs /dev/shm/ainvr-review-frames
  exec timeout 10 "$1" "$2" "$3"
 ' _ "$task_root/test/build/review-frame-cache/review_frame_cache_test" "$task_case/$task_mode" "$task_mode"
done
