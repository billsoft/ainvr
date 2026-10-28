#!/usr/bin/env bash
set -euo pipefail
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$task_root"
mkdir -p test/build/search-frame-admission
g++ -std=c++20 -Wall -Wextra -Werror -pthread -Iai-service/src \
  $(pkg-config --cflags libmongoc-1.0) test/search/search_frame_admission_test.cpp \
  ai-service/src/config/search_producer_grant.cpp ai-service/src/pipeline/postprocessor.cpp \
  $(pkg-config --libs libbson-1.0) -lcrypto -o test/build/search-frame-admission/search_frame_admission_test
timeout 10 test/build/search-frame-admission/search_frame_admission_test
