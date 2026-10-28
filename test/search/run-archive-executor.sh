#!/usr/bin/env bash
set -euo pipefail
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$task_root"
test -f ai-service/src/output/archive_executor.hpp
mkdir -p test/build/search-executor
g++ -std=c++17 -Wall -Wextra -Werror -pthread -Iai-service/src \
  test/search/archive_executor_test.cpp -o test/build/search-executor/archive_executor_test
timeout 10 test/build/search-executor/archive_executor_test
