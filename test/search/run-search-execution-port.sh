#!/usr/bin/env bash
set -euo pipefail
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$task_root"
mkdir -p test/build/search-execution-port
exec 9>test/build/search-execution-port/fixture.lock
flock -n 9 || { echo 'search execution software fixture already active' >&2; exit 1; }
flags=(-std=c++20 -Wall -Wextra -Werror -pthread -Iai-service/src)
binary=test/build/search-execution-port/search_execution_port_test
if [[ ${SEARCH_SANITIZE:-0} == 1 ]]; then
  flags+=(-fsanitize=address,undefined -fno-omit-frame-pointer -O0)
  binary+=-sanitized
fi
g++ "${flags[@]}" $(pkg-config --cflags libmongoc-1.0 cpp-httplib) \
  test/search/search_execution_port_test.cpp ai-service/src/output/search_execution_port.cpp \
  ai-service/src/output/search_hardware_owner.cpp ai-service/src/output/search_prepared_sample.cpp \
  ai-service/src/output/search_producer_http.cpp ai-service/src/output/snapshot_plan.cpp \
  ai-service/src/config/search_producer_grant.cpp ai-service/src/pipeline/postprocessor.cpp \
  search-service/src/model_package.cpp search-service/src/sample_contract.cpp \
  $(pkg-config --libs cpp-httplib libbson-1.0) -lcrypto -o "$binary"
ASAN_OPTIONS=detect_leaks=1 UBSAN_OPTIONS=halt_on_error=1 timeout 30 "$binary"

AINVR_SEARCH_TEST_PACKAGE=siglip-so400m-i18n-full-int8 ASAN_OPTIONS=detect_leaks=1 UBSAN_OPTIONS=halt_on_error=1 timeout 30 "$binary"
