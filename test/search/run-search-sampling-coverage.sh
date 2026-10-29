#!/usr/bin/env bash
set -euo pipefail
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$task_root"
mkdir -p test/build/search-sampling-coverage
flags=(-std=c++20 -Wall -Wextra -Werror -pthread -Iai-service/src)
binary=test/build/search-sampling-coverage/search_sampling_coverage_test
if [[ ${SEARCH_SANITIZE:-0} == 1 ]]; then
  flags+=(-fsanitize=address,undefined -fno-omit-frame-pointer -O0)
  binary+=-sanitized
fi
g++ "${flags[@]}" test/search/search_sampling_coverage_test.cpp -o "$binary"
ASAN_OPTIONS=detect_leaks=1 UBSAN_OPTIONS=halt_on_error=1 timeout 15 "$binary"
