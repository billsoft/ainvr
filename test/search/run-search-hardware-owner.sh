#!/usr/bin/env bash
set -euo pipefail
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$task_root"
mkdir -p test/build/search-hardware-owner
flags=(-std=c++20 -Wall -Wextra -Werror -pthread -Iai-service/src)
binary=test/build/search-hardware-owner/search_hardware_owner_test
if [[ ${SEARCH_SANITIZE:-0} == 1 ]]; then
 flags+=(-fsanitize=address,undefined -fno-omit-frame-pointer -O0)
 binary+=-sanitized
fi
g++ "${flags[@]}" $(pkg-config --cflags libmongoc-1.0) test/search/search_hardware_owner_test.cpp \
 ai-service/src/output/search_hardware_owner.cpp ai-service/src/output/search_prepared_sample.cpp \
 ai-service/src/output/snapshot_plan.cpp ai-service/src/config/search_producer_grant.cpp \
 ai-service/src/pipeline/postprocessor.cpp search-service/src/sample_contract.cpp \
 $(pkg-config --libs libbson-1.0) -lcrypto -o "$binary"
ASAN_OPTIONS=detect_leaks=1 UBSAN_OPTIONS=halt_on_error=1 timeout 15 "$binary"
