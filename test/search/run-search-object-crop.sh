#!/usr/bin/env bash
set -euo pipefail
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$task_root"
mkdir -p test/build/search-object-crop
g++ -std=c++17 -Wall -Wextra -Werror -pthread -Iai-service/src \
  test/search/search_object_crop_test.cpp -o test/build/search-object-crop/search_object_crop_test
timeout 10 test/build/search-object-crop/search_object_crop_test
