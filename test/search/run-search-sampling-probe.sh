#!/usr/bin/env bash
set -euo pipefail
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$task_root"
mkdir -p test/build/search-sampling-probe
flags=(-std=c++20 -Wall -Wextra -Werror -pthread -Iai-service/src)
binary=test/build/search-sampling-probe/search_sampling_probe_test
if [[ ${SEARCH_SANITIZE:-0} == 1 ]];then
 flags+=(-fsanitize=address,undefined -fno-omit-frame-pointer -O0)
 binary+=-sanitized
fi
g++ "${flags[@]}" $(pkg-config --cflags libmongoc-1.0) test/search/search_sampling_probe_test.cpp \
 ai-service/src/pipeline/postprocessor.cpp $(pkg-config --libs libbson-1.0) -o "$binary"
ASAN_OPTIONS=detect_leaks=1 UBSAN_OPTIONS=halt_on_error=1 timeout 15 "$binary"
