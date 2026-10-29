#!/usr/bin/env bash
set -euo pipefail
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$task_root"
mkdir -p test/build/search-migration-sample test/results
exec 9>test/results/search-migration-sample.lock
flock -n 9 || exit 1
"${CXX:-c++}" -std=c++17 -O2 -Wall -Wextra -Werror -pedantic -Isearch-service/src \
  test/search/migration_sample_test.cpp search-service/src/migration_sample.cpp search-service/src/sample_contract.cpp \
  -lcrypto -o test/build/search-migration-sample/migration_sample_test
timeout 15 test/build/search-migration-sample/migration_sample_test
