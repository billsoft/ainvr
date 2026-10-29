#!/usr/bin/env bash
set -euo pipefail
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$task_root"
task_build=test/build/text-embedding-cache
mkdir -p "$task_build" test/results
exec 9>test/results/search-text-cache.lock
flock -n 9 || { printf '%s\n' 'Another software text-cache test owns this build.' >&2; exit 1; }
"${CXX:-c++}" -std=c++17 -O2 -Wall -Wextra -Werror -pedantic \
  test/search/text_embedding_cache_test.cpp -o "$task_build/text_embedding_cache_test"
timeout 15 "$task_build/text_embedding_cache_test"
