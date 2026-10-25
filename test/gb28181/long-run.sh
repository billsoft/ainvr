#!/bin/sh
# Serial long tests against an isolated SRS; never production camera inputs.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
mkdir -p out/gb28181
exec 9>out/gb28181/long-run.lock
flock -n 9 || { echo 'A long-run suite is already active'; exit 1; }
echo "Four-channel test started $(date -Is)"
timeout --kill-after=45 7320 nice -n 10 python3 test/gb28181/soak.py --channels 4 --seconds 7200
echo "Two-channel test started $(date -Is)"
timeout --kill-after=45 86520 nice -n 10 python3 test/gb28181/soak.py --channels 2 --seconds 86400
echo "Both duration gates completed $(date -Is)"
