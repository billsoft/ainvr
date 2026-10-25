#!/bin/sh
# Run after any existing media long test; never interrupt its evidence.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
: "${AINVR_GB_TEST_GATEWAY:?Provide the immutable gateway binary to validate}"
: "${AINVR_GB_TEST_RESULTS:?Provide a fresh result directory}"
test -x "$AINVR_GB_TEST_GATEWAY"
mkdir -p "$AINVR_GB_TEST_RESULTS"
exec 8>out/gb28181/acceptance.lock
flock -n 8 || { echo 'Acceptance already queued'; exit 1; }
echo "Waiting for existing media test: $(date -Is)"
exec 9>out/gb28181/long-run.lock
flock 9
export AINVR_GB_TEST_GATEWAY AINVR_GB_TEST_RESULTS
sha256sum "$AINVR_GB_TEST_GATEWAY" > "$AINVR_GB_TEST_RESULTS/gateway.sha256"
trap 'code=$?; printf "%s exit=%s\n" "$(date -Is)" "$code" > "$AINVR_GB_TEST_RESULTS/completion.txt"' EXIT
echo "Matrix started: $(date -Is)"
timeout --kill-after=45 6000 nice -n 10 python3 test/gb28181/matrix.py
echo "Production recorder command tests: $(date -Is)"
timeout --kill-after=20 90 python3 test/gb28181/pipeline_probe.py --version 3.0 --signaling tcp --media tcp-passive --fixture h264-aac --recorder
timeout --kill-after=20 90 python3 test/gb28181/pipeline_probe.py --version 3.0 --signaling tcp --media tcp-active --fixture hevc-alaw --video hevc --recorder
echo "Four-channel two-hour test: $(date -Is)"
timeout --kill-after=45 7320 nice -n 10 python3 test/gb28181/soak.py --channels 4 --seconds 7200
echo "Two-channel 24-hour test: $(date -Is)"
timeout --kill-after=45 86520 nice -n 10 python3 test/gb28181/soak.py --channels 2 --seconds 86400
echo "Selected media acceptance gates passed: $(date -Is)"
