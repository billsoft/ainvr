#!/usr/bin/env bash
# Copyright (c) 2026 AINVR. Build the non-AI services on the target board.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
BUILD="$ROOT/out/build/s100p-license"
case "${1:-}" in
  --help|-h) echo 'Usage: build-s100p.sh [--skip-deps]'; exit 0;;
  ''|--skip-deps) ;;
  *) echo "Unknown argument: $1" >&2; exit 2;;
esac
[[ "$(uname -m)" == aarch64 ]] || { echo 'This build requires an aarch64 target'; exit 1; }
[[ "$(node --version)" == v24.* ]] || { echo 'Install Node.js 24.x first'; exit 1; }
[[ -x "$ROOT/.venv/bin/python" ]] || python3 -m venv "$ROOT/.venv"
if [[ "${1:-}" != --skip-deps ]]; then
  "$ROOT/.venv/bin/python" -m pip install -r "$ROOT/deploy-package/requirements-non-ai.txt"
  (cd "$ROOT/srs-web-console/backend" && npm ci --no-audit --no-fund)
  (cd "$ROOT/srs-web-console/frontend" && npm ci --no-audit --no-fund)
fi
(cd "$ROOT/srs-web-console/backend" && npm run build)
(cd "$ROOT/srs-web-console/frontend" && npm run build)
cmake -S "$ROOT/license-service" -B "$BUILD" -DBUILD_TESTING=ON -DCMAKE_BUILD_TYPE=RelWithDebInfo
cmake --build "$BUILD" -j "${AINVR_BUILD_JOBS:-4}"
ctest --test-dir "$BUILD" --output-on-failure
echo "AINVR non-AI build ready: $ROOT"
