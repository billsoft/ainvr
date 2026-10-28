#!/usr/bin/env bash
set -euo pipefail
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$task_root"
test -f ai-service/src/output/search_sampling_policy.hpp
mkdir -p test/build/search-sampling-policy
g++ -std=c++17 -Wall -Wextra -Werror -pthread -Iai-service/src \
  $(pkg-config --cflags libmongoc-1.0) test/search/search_sampling_policy_test.cpp \
  $(pkg-config --libs libbson-1.0) -o test/build/search-sampling-policy/search_sampling_policy_test
timeout 10 test/build/search-sampling-policy/search_sampling_policy_test
