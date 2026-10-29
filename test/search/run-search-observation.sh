#!/usr/bin/env bash
set -euo pipefail
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$task_root"
mkdir -p test/build/search-observation
g++ -std=c++20 -O3 -Wall -Wextra -Werror -Iai-service/src test/search/search_observation_test.cpp -o test/build/search-observation/search_observation_test
timeout 10 test/build/search-observation/search_observation_test
