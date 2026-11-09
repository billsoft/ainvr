#!/usr/bin/env bash
set -euo pipefail
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$task_root"
mkdir -p /mnt/ainvr-ssd/ainvr-tests
task_case=$(mktemp -d /mnt/ainvr-ssd/ainvr-tests/review-cache-XXXXXXXX)
cleanup(){
 python3 - "$task_case" <<'PY'
import pathlib,shutil,sys
p=pathlib.Path(sys.argv[1]);assert p.parent==pathlib.Path('/mnt/ainvr-ssd/ainvr-tests') and p.name.startswith('review-cache-') and p.resolve()==p
shutil.rmtree(p)
PY
}
trap cleanup EXIT
g++ -std=c++17 -O1 -Wall -Wextra -Werror -Wno-misleading-indentation -pthread -I/usr/include/opencv4 \
 test/ai_port/review_frame_cache_test.cpp -lopencv_core -lcrypto -o "$task_case/review_frame_cache_test"
task_modes=(queue pixels ttl targets receipts shutdown backpressure encoded persist_failure)
if [[ ${1:-all} != all ]]; then task_modes=("$1"); fi
for task_mode in "${task_modes[@]}"; do
 timeout 15 "$task_case/review_frame_cache_test" "$task_case/$task_mode" "$task_mode"
done
