#!/usr/bin/env bash
set -euo pipefail
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$task_root"
mkdir -p test/build/search-producer-http
exec 9>test/build/search-producer-http/fixture.lock
flock -n 9 || { echo 'search HTTP fixture already active' >&2; exit 1; }
flags=(-std=c++20 -Wall -Wextra -Werror -pthread -Iai-service/src)
binary=test/build/search-producer-http/search_producer_http_test
if [[ ${SEARCH_SANITIZE:-0} == 1 ]]; then
 flags+=(-fsanitize=address,undefined -fno-omit-frame-pointer -O0)
 binary+=-sanitized
fi
g++ "${flags[@]}" $(pkg-config --cflags libmongoc-1.0 cpp-httplib) \
 test/search/search_producer_http_test.cpp ai-service/src/output/search_producer_http.cpp \
 ai-service/src/config/search_producer_grant.cpp search-service/src/sample_contract.cpp \
 $(pkg-config --libs cpp-httplib libbson-1.0) -lcrypto -o "$binary"
export AINVR_SEARCH_HTTP_FIXTURE_PID="$task_root/test/build/search-producer-http/fixture.pid"
trap 'rm -f -- "$AINVR_SEARCH_HTTP_FIXTURE_PID"' EXIT
ASAN_OPTIONS=detect_leaks=1 UBSAN_OPTIONS=halt_on_error=1 timeout 30 "$binary"
